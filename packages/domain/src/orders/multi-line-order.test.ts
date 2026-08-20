import { describe, expect, it } from "vitest";

import { convertQuantity } from "../units/convert.js";
import type { RecipeComponent } from "../capacity/calculate-capacity.js";
import { evaluateOrder, type OrderEvaluationInput } from "./evaluate-order.js";

/**
 * Multi-line orders, protected stock, and loss in blockers.
 *
 * A review proved the previous implementation assessed only the FIRST line and
 * multiplied `perUnitBase` raw. Each test here reproduces one of its probes; the
 * existing multi-line test could not catch any of them because both of its lines
 * shared a single components array, so first-line-only and all-lines gave the
 * same answer.
 */

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL_A = "0199a200-0000-7000-8000-00000000000a";
const VESSEL_B = "0199a200-0000-7000-8000-00000000000b";
const FINISHED_A = "0199a200-0000-7000-8000-0000000000b1";
const FINISHED_B = "0199a200-0000-7000-8000-0000000000b2";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

function line(finishedItemId: string, vesselId: string, orderedUnits: number, loss = false) {
  const components: RecipeComponent[] = [
    {
      itemId: WAX,
      perUnitBase: oz("15.7"),
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: loss ? { mode: "PERCENT_PER_UNIT", percentage: "0.5" } : { mode: "NONE" },
      countable: false,
    },
    {
      itemId: vesselId,
      perUnitBase: "1",
      dependencyClass: "PRODUCTION_CRITICAL",
      loss: { mode: "NONE" },
      countable: true,
    },
  ];
  return { finishedItemId, orderedUnits, finishedAvailable: "0", recipeVersionId: "r1", components };
}

function order(
  lines: OrderEvaluationInput["lines"],
  availableByItem: Record<string, string>,
  extra: Partial<OrderEvaluationInput> = {},
): OrderEvaluationInput {
  return {
    orderId: "0199a600-0000-7000-8000-000000000001",
    dueAt: "2026-09-01T00:00:00.000Z",
    assessedAt: "2026-08-16T12:00:00.000Z",
    lastAuthoritativeSyncAt: "2026-08-16T11:59:00.000Z",
    stalenessThresholdMinutes: 60,
    lines,
    packingComponents: [],
    availableByItem,
    lossEnabled: true,
    ...extra,
  };
}

describe("multi-line orders", () => {
  it("does not call an order makeable when a later line is impossible", () => {
    // Probe B: line 2's vessel is out of stock. This previously reported
    // MAKEABLE_BEFORE_DUE with ZERO blockers — a silent false green.
    const result = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 1), line(FINISHED_B, VESSEL_B, 1)], {
        [WAX]: oz("1000"),
        [VESSEL_A]: "1000",
        [VESSEL_B]: "0",
      }),
    );
    expect(result.productionRequired).toBe(2);
    expect(result.makeableUnits).toBe(1);
    expect(result.productionStatus).toBe("PARTIAL");
    expect(result.productionBlockers.map((b) => b.itemId)).toContain(VESSEL_B);
  });

  it("names the line that is actually short, not the first line", () => {
    // Probe A: vessel A is exactly sufficient for its own line; vessel B is the
    // real constraint. Naming vessel A sent the owner to buy the wrong thing.
    const result = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 10), line(FINISHED_B, VESSEL_B, 10)], {
        [WAX]: oz("10000"),
        [VESSEL_A]: "10",
        [VESSEL_B]: "0",
      }),
    );
    expect(result.productionBlockers.map((b) => b.itemId)).toContain(VESSEL_B);
    expect(result.productionBlockers.map((b) => b.itemId)).not.toContain(VESSEL_A);
  });

  it("does not promise the same shared wax to two lines", () => {
    // Wax for exactly 10 candles across two lines of 8. Without a running pool
    // the second line would be told the full stock was still available.
    const result = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 8), line(FINISHED_B, VESSEL_B, 8)], {
        [WAX]: oz("157"),
        [VESSEL_A]: "100",
        [VESSEL_B]: "100",
      }),
    );
    expect(result.makeableUnits).toBe(10);
    expect(result.productionStatus).toBe("PARTIAL");
  });
});

describe("blocker accuracy", () => {
  it("includes process loss in the reported shortfall", () => {
    // Probe C: 10 units at 50% loss needs 1.5x the raw quantity. The raw
    // multiplication under-reported the shortfall by 56%, so buying exactly
    // what it asked for still could not fill the order.
    const result = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 10, true)], {
        [WAX]: oz("100"),
        [VESSEL_A]: "100",
      }),
    );
    const blocker = result.productionBlockers.find((b) => b.itemId === WAX)!;
    const required = Number(blocker.required);
    // 10 x 15.7 oz x 1.5 = 235.5 oz, not 157.
    expect(required).toBeCloseTo(Number(oz("235.5")), 4);
  });

  it("applies the loss policy to makeableUnits, not just to the blocker", () => {
    // Forcing lossEnabled:false inside the capacity call survived every test:
    // the loss cases asserted the reported shortfall but never how many units
    // were actually makeable, which is the number the operator acts on.
    // 157 oz of wax at 50% loss makes 6 candles, not 10.
    const withLoss = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 10, true)], { [WAX]: oz("157"), [VESSEL_A]: "100" }),
    );
    const withoutLoss = evaluateOrder(
      order([line(FINISHED_A, VESSEL_A, 10, true)], { [WAX]: oz("157"), [VESSEL_A]: "100" }, {
        lossEnabled: false,
      }),
    );
    expect(withoutLoss.makeableUnits).toBe(10);
    expect(withLoss.makeableUnits).toBe(6);
  });

  it("measures the shortfall against usable stock, not raw availability", () => {
    // Probe D: every gram is protected, so none is usable. Reporting the raw
    // figure told the owner stock was available that they had held back.
    const result = evaluateOrder(
      order(
        [line(FINISHED_A, VESSEL_A, 10)],
        { [WAX]: oz("157"), [VESSEL_A]: "100" },
        { protectedByItem: { [WAX]: oz("157") } },
      ),
    );
    expect(result.makeableUnits).toBe(0);
    const blocker = result.productionBlockers.find((b) => b.itemId === WAX)!;
    expect(blocker.available).toBe("0");
  });
});

describe("whole units", () => {
  it("never allocates a fractional finished candle", () => {
    // Previously Number()/Math.min yielded 2.9 allocated and 2.1 to produce.
    const result = evaluateOrder(
      order([{ ...line(FINISHED_A, VESSEL_A, 5), finishedAvailable: "2.9" }], {
        [WAX]: oz("1000"),
        [VESSEL_A]: "100",
      }),
    );
    expect(Number.isInteger(result.finishedAllocated)).toBe(true);
    expect(Number.isInteger(result.productionRequired)).toBe(true);
    expect(result.finishedAllocated).toBe(2);
    expect(result.productionRequired).toBe(3);
  });

  it("refuses a fractional ordered quantity", () => {
    expect(() =>
      evaluateOrder(
        order([{ ...line(FINISHED_A, VESSEL_A, 1), orderedUnits: 2.5 }], { [WAX]: oz("1000") }),
      ),
    ).toThrow("non-negative integer");
  });
});
