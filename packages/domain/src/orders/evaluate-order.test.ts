import { describe, expect, it } from "vitest";

import { convertQuantity } from "../units/convert.js";
import type { RecipeComponent } from "../capacity/calculate-capacity.js";
import { evaluateOrder, type OrderEvaluationInput } from "./evaluate-order.js";

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const BOX = "0199a200-0000-7000-8000-000000000008";
const FILLER = "0199a200-0000-7000-8000-000000000009";
const RIBBON = "0199a200-0000-7000-8000-00000000000a";
const FINISHED = "0199a200-0000-7000-8000-0000000000b1";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

function production(): RecipeComponent[] {
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
  ];
}

type Opts = {
  ordered: number;
  finished: number;
  waxOunces?: string;
  vessels?: string;
  shippingBoxes?: number;
  filler?: number;
  ribbon?: number;
  dueAt?: string | null;
  packing?: { itemId: string; perOrder: number; dependencyClass: RecipeComponent["dependencyClass"] }[];
};

function orderFixture(opts: Opts): OrderEvaluationInput {
  const packing =
    opts.packing ??
    [{ itemId: BOX, perOrder: 1, dependencyClass: "FULFILLMENT_CRITICAL" as const }];
  return {
    orderId: "0199a600-0000-7000-8000-000000000001",
    dueAt: opts.dueAt ?? "2026-09-01T00:00:00.000Z",
    assessedAt: "2026-08-16T12:00:00.000Z",
    lastAuthoritativeSyncAt: "2026-08-16T11:59:00.000Z",
    stalenessThresholdMinutes: 60,
    lines: [
      {
        finishedItemId: FINISHED,
        orderedUnits: opts.ordered,
        finishedAvailable: String(opts.finished),
        recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
        components: production(),
      },
    ],
    packingComponents: packing,
    availableByItem: {
      [WAX]: oz(opts.waxOunces ?? "1570"),
      [VESSEL]: String(opts.vessels ?? 100),
      [BOX]: String(opts.shippingBoxes ?? 10),
      [FILLER]: String(opts.filler ?? 10),
      [RIBBON]: String(opts.ribbon ?? 10),
    },
    lossEnabled: true,
  };
}

describe("evaluateOrder", () => {
  it("uses finished goods before production capacity", () => {
    const result = evaluateOrder(orderFixture({ ordered: 5, finished: 3 }));
    expect(result.finishedAllocated).toBe(3);
    expect(result.productionRequired).toBe(2);
    expect(result.productionStatus).toBe("MAKEABLE_BEFORE_DUE");
  });

  it("does not reduce candle capacity when a shipping box is missing", () => {
    const result = evaluateOrder(orderFixture({ ordered: 2, finished: 2, shippingBoxes: 0 }));
    // Production is complete; only shipping is blocked. Conflating the two
    // would tell the owner to make candles they already have.
    expect(result.productionStatus).toBe("READY_FROM_FINISHED");
    expect(result.fulfillmentStatus).toBe("BLOCKED_FULFILLMENT_MATERIAL");
  });

  it("reports READY_FROM_FINISHED when stock covers the whole order", () => {
    const result = evaluateOrder(orderFixture({ ordered: 4, finished: 4 }));
    expect(result.productionStatus).toBe("READY_FROM_FINISHED");
    expect(result.productionRequired).toBe(0);
    expect(result.fulfillmentStatus).toBe("READY");
  });

  it("reports PARTIAL when only some of the shortfall can be produced", () => {
    // 10 ordered, 0 finished, wax for only 4.
    const result = evaluateOrder(
      orderFixture({ ordered: 10, finished: 0, waxOunces: "62.8" }),
    );
    expect(result.productionStatus).toBe("PARTIAL");
    expect(result.makeableUnits).toBe(4);
  });

  it("reports BLOCKED_PRODUCTION when nothing can be made", () => {
    const result = evaluateOrder(orderFixture({ ordered: 5, finished: 0, waxOunces: "0" }));
    expect(result.productionStatus).toBe("BLOCKED_PRODUCTION");
    expect(result.makeableUnits).toBe(0);
  });

  it("lists the blocking item with quantities on a production block", () => {
    const result = evaluateOrder(orderFixture({ ordered: 5, finished: 0, waxOunces: "0" }));
    const blocker = result.productionBlockers.find((b) => b.itemId === WAX);
    expect(blocker).toBeDefined();
    expect(blocker!.available).toBe("0");
    expect(blocker!.shortfall).not.toBe("0");
  });

  describe("advisory materials", () => {
    it("warns without blocking either stage", () => {
      const result = evaluateOrder(
        orderFixture({
          ordered: 2,
          finished: 2,
          ribbon: 0,
          packing: [
            { itemId: BOX, perOrder: 1, dependencyClass: "FULFILLMENT_CRITICAL" },
            { itemId: RIBBON, perOrder: 1, dependencyClass: "ADVISORY" },
          ],
        }),
      );
      expect(result.productionStatus).toBe("READY_FROM_FINISHED");
      expect(result.fulfillmentStatus).toBe("READY_WITH_ADVISORY_WARNINGS");
      expect(result.advisoryWarnings.map((w) => w.itemId)).toContain(RIBBON);
    });

    it("does not raise a warning when advisory stock is sufficient", () => {
      const result = evaluateOrder(
        orderFixture({
          ordered: 2,
          finished: 2,
          ribbon: 10,
          packing: [
            { itemId: BOX, perOrder: 1, dependencyClass: "FULFILLMENT_CRITICAL" },
            { itemId: RIBBON, perOrder: 1, dependencyClass: "ADVISORY" },
          ],
        }),
      );
      expect(result.fulfillmentStatus).toBe("READY");
      expect(result.advisoryWarnings).toEqual([]);
    });
  });

  describe("staleness", () => {
    it("marks the assessment stale when sync is older than the threshold", () => {
      const base = orderFixture({ ordered: 2, finished: 2 });
      const result = evaluateOrder({
        ...base,
        lastAuthoritativeSyncAt: "2026-08-16T08:00:00.000Z",
      });
      // Four hours old against a 60 minute threshold. The numbers may still be
      // right, but the operator must be told they might not be.
      expect(result.stale).toBe(true);
      expect(result.lastAuthoritativeSyncAt).toBe("2026-08-16T08:00:00.000Z");
    });

    it("is not stale within the threshold", () => {
      expect(evaluateOrder(orderFixture({ ordered: 2, finished: 2 })).stale).toBe(false);
    });

    it("always reports the authoritative timestamp, stale or not", () => {
      const result = evaluateOrder(orderFixture({ ordered: 2, finished: 2 }));
      expect(result.lastAuthoritativeSyncAt).toBe("2026-08-16T11:59:00.000Z");
    });
  });

  describe("packing rules", () => {
    it("scales packing material by order quantity where specified per unit", () => {
      const result = evaluateOrder(
        orderFixture({
          ordered: 5,
          finished: 5,
          filler: 2,
          packing: [
            { itemId: BOX, perOrder: 1, dependencyClass: "FULFILLMENT_CRITICAL" },
            { itemId: FILLER, perOrder: 5, dependencyClass: "FULFILLMENT_CRITICAL" },
          ],
        }),
      );
      // Needs 5 filler, has 2.
      expect(result.fulfillmentStatus).toBe("BLOCKED_FULFILLMENT_MATERIAL");
      expect(result.fulfillmentBlockers.map((b) => b.itemId)).toContain(FILLER);
    });

    it("evaluates packing independently of production shortfall", () => {
      // Production blocked AND shipping blocked: both must be reported, since
      // fixing only one still leaves the order unshippable.
      const result = evaluateOrder(
        orderFixture({ ordered: 5, finished: 0, waxOunces: "0", shippingBoxes: 0 }),
      );
      expect(result.productionStatus).toBe("BLOCKED_PRODUCTION");
      expect(result.fulfillmentStatus).toBe("BLOCKED_FULFILLMENT_MATERIAL");
    });
  });

  it("does not count incoming purchases toward current readiness", () => {
    const base = orderFixture({ ordered: 5, finished: 0, waxOunces: "0" });
    const result = evaluateOrder({ ...base, incomingByItem: { [WAX]: oz("1000") } });
    // Inbound stock is reported for planning but must never make an order look
    // shippable today.
    expect(result.productionStatus).toBe("BLOCKED_PRODUCTION");
    const blocker = result.productionBlockers.find((b) => b.itemId === WAX);
    expect(blocker!.incoming).toBe(oz("1000"));
  });

  it("handles a multi-line order", () => {
    const base = orderFixture({ ordered: 2, finished: 2 });
    const result = evaluateOrder({
      ...base,
      lines: [
        base.lines[0]!,
        { ...base.lines[0]!, finishedItemId: "0199a200-0000-7000-8000-0000000000b2", orderedUnits: 3, finishedAvailable: "0" },
      ],
    });
    expect(result.finishedAllocated).toBe(2);
    expect(result.productionRequired).toBe(3);
  });

  it("treats a zero-unit order as ready rather than throwing", () => {
    const result = evaluateOrder(orderFixture({ ordered: 0, finished: 0 }));
    expect(result.productionStatus).toBe("READY_FROM_FINISHED");
  });

  describe("unparseable instants", () => {
    it("an unparseable sync timestamp is an error, never silently fresh", () => {
      // NaN comparisons all answer false, so `NaN > threshold` used to report
      // stale: false -- bad data looking fresher than any real timestamp.
      const base = orderFixture({ ordered: 2, finished: 2 });
      expect(() =>
        evaluateOrder({ ...base, lastAuthoritativeSyncAt: "not-a-date" }),
      ).toThrow(/instant/);
    });

    it("an unparseable assessedAt is an error, never silently fresh", () => {
      const base = orderFixture({ ordered: 2, finished: 2 });
      expect(() => evaluateOrder({ ...base, assessedAt: "garbage" })).toThrow(/instant/);
    });
  });
});
