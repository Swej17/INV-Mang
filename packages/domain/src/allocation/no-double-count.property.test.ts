import { describe, expect, it } from "vitest";

import { Decimal, convertQuantity } from "../units/convert.js";
import type { RecipeComponent } from "../capacity/calculate-capacity.js";
import { requiredForUnits } from "../capacity/calculate-capacity.js";
import {
  allocateProduction,
  type AllocationRequest,
  type ProductionDemand,
} from "./allocate-production.js";

/**
 * The invariant the design document calls critical: a component cannot be
 * allocated twice.
 *
 * Per-product capacity is hypothetical — ask about two scents separately and
 * both answers count the same wax. An allocated plan must resolve that. These
 * properties assert it across generated inputs, because the failure is silent:
 * an over-allocated plan looks perfectly fine until production runs out of wax
 * halfway through and a paid order cannot ship.
 */

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const WICK = "0199a200-0000-7000-8000-000000000007";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

function* samples(count: number, seed = 20260816): Generator<number> {
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    yield state % 97;
  }
}

function components(): RecipeComponent[] {
  return [
    {
      itemId: WAX,
      perUnitBase: oz("15.7"),
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: { mode: "NONE" },
      countable: false,
    },
    {
      itemId: VESSEL,
      perUnitBase: "1",
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: { mode: "NONE" },
      countable: true,
    },
    {
      itemId: WICK,
      perUnitBase: "1",
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: { mode: "NONE" },
      countable: true,
    },
  ];
}

function demand(id: string, units: number, priority: number): ProductionDemand {
  return {
    finishedItemId: id,
    sku: `SKU-${id}`,
    requestedUnits: units,
    recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
    components: components(),
    paidOrderDueAt: null,
    orderShortfallUnits: 0,
    ownerPriority: priority,
    forecastStockoutAt: null,
    salesVelocity: "0",
  };
}

/** Total material the plan claims, recomputed independently of the result. */
function recomputeConsumption(
  request: AllocationRequest,
  lines: readonly { finishedItemId: string; allocatedUnits: number }[],
): Map<string, InstanceType<typeof Decimal>> {
  const totals = new Map<string, InstanceType<typeof Decimal>>();
  for (const line of lines) {
    const source = request.demands.find((d) => d.finishedItemId === line.finishedItemId)!;
    for (const component of source.components) {
      if (component.dependencyClass !== "PRODUCTION_CRITICAL") continue;
      if (line.allocatedUnits <= 0) continue;
      const used = requiredForUnits(
        component,
        BigInt(line.allocatedUnits),
        request.lossEnabled,
      );
      totals.set(
        component.itemId,
        (totals.get(component.itemId) ?? new Decimal(0)).plus(used),
      );
    }
  }
  return totals;
}

describe("no double counting", () => {
  it("summed consumption never exceeds initial availability", () => {
    for (const n of samples(150)) {
      const waxOunces = String(n * 3);
      const request: AllocationRequest = {
        demands: [
          demand("a", n % 13, 9),
          demand("b", n % 7, 5),
          demand("c", n % 5, 1),
        ],
        availableByItem: { [WAX]: oz(waxOunces), [VESSEL]: String(n), [WICK]: String(n) },
        lossEnabled: true,
      };
      const result = allocateProduction(request);

      // Recomputed from the lines, not trusted from consumptionByItem, so a bug
      // in the reported total cannot hide a bug in the allocation.
      const totals = recomputeConsumption(request, result.lines);
      for (const [itemId, used] of totals) {
        const initial = new Decimal(request.availableByItem[itemId] ?? "0");
        expect(used.lessThanOrEqualTo(initial)).toBe(true);
      }
    }
  });

  it("reported consumption matches an independent recomputation", () => {
    for (const n of samples(100, 41)) {
      const request: AllocationRequest = {
        demands: [demand("a", n % 11, 9), demand("b", n % 6, 4)],
        availableByItem: {
          [WAX]: oz(String(n * 4)),
          [VESSEL]: String(n),
          [WICK]: String(n),
        },
        lossEnabled: true,
      };
      const result = allocateProduction(request);
      const totals = recomputeConsumption(request, result.lines);
      for (const [itemId, used] of totals) {
        expect(result.consumptionByItem[itemId]).toBe(used.toFixed());
      }
    }
  });

  it("consumption plus residual equals what we started with", () => {
    // Conservation. Material cannot appear or vanish inside the planner.
    for (const n of samples(100, 7)) {
      const available: Record<string, string> = {
        [WAX]: oz(String(n * 3)),
        [VESSEL]: String(n),
        [WICK]: String(n),
      };
      const request: AllocationRequest = {
        demands: [demand("a", n % 9, 9), demand("b", n % 4, 2)],
        availableByItem: available,
        lossEnabled: true,
      };
      const result = allocateProduction(request);
      for (const itemId of Object.keys(available)) {
        const used = new Decimal(result.consumptionByItem[itemId] ?? "0");
        const left = new Decimal(result.residualByItem[itemId] ?? "0");
        expect(used.plus(left).toFixed()).toBe(new Decimal(available[itemId]!).toFixed());
      }
    }
  });

  it("residual is never negative", () => {
    for (const n of samples(100, 99)) {
      const result = allocateProduction({
        demands: [demand("a", 50, 9), demand("b", 50, 5), demand("c", 50, 1)],
        availableByItem: { [WAX]: oz(String(n)), [VESSEL]: String(n), [WICK]: String(n) },
        lossEnabled: true,
      });
      for (const value of Object.values(result.residualByItem)) {
        expect(new Decimal(value).isNegative()).toBe(false);
      }
    }
  });

  it("no line is allocated more than it requested", () => {
    for (const n of samples(100, 3)) {
      const result = allocateProduction({
        demands: [demand("a", n % 8, 9), demand("b", n % 5, 3)],
        availableByItem: { [WAX]: oz("100000"), [VESSEL]: "100000", [WICK]: "100000" },
        lossEnabled: true,
      });
      for (const line of result.lines) {
        expect(line.allocatedUnits).toBeLessThanOrEqual(line.requestedUnits);
        expect(line.allocatedUnits).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("allocating the same plan twice yields identical results", () => {
    // Determinism: the SKU tie-breaker must make a re-run reproducible, or a
    // dry run could differ from the plan the owner then commits.
    for (const n of samples(40, 555)) {
      const build = (): AllocationRequest => ({
        demands: [demand("a", n % 9, 5), demand("b", n % 9, 5), demand("c", n % 9, 5)],
        availableByItem: { [WAX]: oz(String(n * 2)), [VESSEL]: String(n), [WICK]: String(n) },
        lossEnabled: true,
      });
      const first = allocateProduction(build());
      const second = allocateProduction(build());
      expect(first.lines.map((l) => [l.sku, l.allocatedUnits])).toEqual(
        second.lines.map((l) => [l.sku, l.allocatedUnits]),
      );
    }
  });

  it("a plan never allocates more in total than a single-product capacity would", () => {
    // Sanity ceiling: the sum across all lines cannot exceed what the shared
    // pool could make for one product alone.
    for (const n of samples(80, 17)) {
      const available = { [WAX]: oz(String(n * 3)), [VESSEL]: String(n), [WICK]: String(n) };
      const result = allocateProduction({
        demands: [demand("a", 200, 9), demand("b", 200, 5)],
        availableByItem: available,
        lossEnabled: true,
      });
      const totalAllocated = result.lines.reduce((sum, line) => sum + line.allocatedUnits, 0);
      // Vessels and wicks are one-per-unit, so they cap the total directly.
      expect(totalAllocated).toBeLessThanOrEqual(n);
    }
  });
});
