import { describe, expect, it } from "vitest";

import { Decimal, convertQuantity } from "../units/convert.js";
import {
  calculateCapacity,
  requiredForUnits,
  type CapacityInput,
  type LossPolicy,
  type RecipeComponent,
} from "./calculate-capacity.js";

/**
 * Invariants, not examples.
 *
 * These are the properties the design document calls critical: loss and
 * protection may only ever reduce capacity, and adjusted may never exceed
 * theoretical. An example test proves one case; these assert the rule across
 * generated inputs, which is what stops a future refactor quietly inverting a
 * comparison.
 */

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

/** Deterministic sampling; a fixed seed keeps a red build reproducible. */
function* samples(count: number, seed = 20260816): Generator<number> {
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    yield state % 500;
  }
}

function input(
  waxOunces: string,
  vessels: string,
  overrides: Partial<CapacityInput> = {},
  loss: LossPolicy = { mode: "NONE" },
): CapacityInput {
  const components: RecipeComponent[] = [
    {
      itemId: WAX,
      perUnitBase: oz("15.7"),
      dependencyClass: "PRODUCTION_CRITICAL",
      loss,
      countable: false,
    },
    {
      itemId: VESSEL,
      perUnitBase: "1",
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: { mode: "NONE" },
      countable: true,
    },
  ];
  return {
    recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
    components,
    availableByItem: { [WAX]: oz(waxOunces), [VESSEL]: vessels },
    lossEnabled: true,
    ...overrides,
  };
}

describe("capacity invariants", () => {
  it("adjusted never exceeds theoretical", () => {
    for (const n of samples(120)) {
      const result = calculateCapacity(
        input(String(n), String(n), { protectedByItem: { [WAX]: oz(String(n % 40)) } }, {
          mode: "PERCENT_PER_UNIT",
          percentage: "0.07",
        }),
      );
      expect(result.adjustedUnits).toBeLessThanOrEqual(result.theoreticalUnits);
    }
  });

  it("process loss never increases capacity", () => {
    for (const n of samples(120, 31)) {
      const without = calculateCapacity(input(String(n), String(n), { lossEnabled: false }, {
        mode: "PERCENT_PER_UNIT",
        percentage: "0.12",
      }));
      const with_ = calculateCapacity(input(String(n), String(n), { lossEnabled: true }, {
        mode: "PERCENT_PER_UNIT",
        percentage: "0.12",
      }));
      expect(with_.adjustedUnits).toBeLessThanOrEqual(without.adjustedUnits);
    }
  });

  it("protected stock never increases capacity", () => {
    for (const n of samples(120, 77)) {
      const unprotected = calculateCapacity(input(String(n), String(n)));
      const protected_ = calculateCapacity(
        input(String(n), String(n), { protectedByItem: { [WAX]: oz(String((n % 30) + 1)) } }),
      );
      expect(protected_.adjustedUnits).toBeLessThanOrEqual(unprotected.adjustedUnits);
    }
  });

  it("capacity is monotonic in available material", () => {
    let previous = -1;
    for (const n of [...samples(60, 5)].sort((a, b) => a - b)) {
      const units = calculateCapacity(input(String(n), "100000")).adjustedUnits;
      expect(units).toBeGreaterThanOrEqual(previous);
      previous = units;
    }
  });

  it("never reports negative capacity", () => {
    for (const n of samples(60, 11)) {
      const result = calculateCapacity(
        input(String(n % 10), String(n % 10), {
          protectedByItem: { [WAX]: oz("100000") },
        }),
      );
      expect(result.adjustedUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it("the reported capacity is actually producible, and one more is not", () => {
    // The tightest property: whatever number we return must be affordable, and
    // the next unit must not be. Off-by-one in the search fails here.
    for (const n of samples(80, 909)) {
      const built = input(String(n), "100000");
      const result = calculateCapacity(built);
      const wax = built.components[0]!;
      const available = built.availableByItem[WAX]!;

      const forReported = requiredForUnits(wax, BigInt(result.adjustedUnits), true);
      expect(forReported.lessThanOrEqualTo(available)).toBe(true);

      const forOneMore = requiredForUnits(wax, BigInt(result.adjustedUnits + 1), true);
      expect(forOneMore.greaterThan(available)).toBe(true);
    }
  });

  it("fixed batch loss is charged per started batch, never fractionally", () => {
    const loss: LossPolicy = {
      mode: "FIXED_PER_BATCH",
      fixedPerBatchBase: oz("1"),
      batchSize: 10,
    };
    const component: RecipeComponent = {
      itemId: WAX,
      perUnitBase: oz("15.7"),
      dependencyClass: "PRODUCTION_CRITICAL",
      loss,
      countable: false,
    };
    // 1..10 units all pay exactly one batch charge; 11 pays two.
    // Expectations are built in Decimal: computing 15.7 * units in JavaScript
    // Number drifts (…31249982990286125 instead of …3125) and would make this
    // test disagree with a correct implementation.
    for (let units = 1n; units <= 10n; units += 1n) {
      const ounces = new Decimal("15.7").times(units.toString()).plus(1).toFixed();
      const expected = convertQuantity({ value: ounces, unit: "OUNCE" }, "GRAM").value;
      expect(requiredForUnits(component, units, true).toFixed()).toBe(expected);
    }
    const eleven = requiredForUnits(component, 11n, true).toFixed();
    expect(eleven).toBe(oz("174.7"));
  });
});
