import { describe, expect, it } from "vitest";

import { convertQuantity } from "../units/convert.js";
import type { RecipeComponent } from "../capacity/calculate-capacity.js";
import {
  allocateProduction,
  type AllocationRequest,
  type ProductionDemand,
} from "./allocate-production.js";

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const LAVENDER = "0199a300-0000-7000-8000-000000000001";
const CEDAR = "0199a300-0000-7000-8000-000000000002";
const AMBER = "0199a300-0000-7000-8000-000000000003";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

/** Both scents draw on the same wax and vessels — the whole point of Task 6. */
function sharedComponents(): RecipeComponent[] {
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

function demand(overrides: Partial<ProductionDemand> & { finishedItemId: string }): ProductionDemand {
  return {
    sku: `SKU-${overrides.finishedItemId.slice(-4)}`,
    requestedUnits: 0,
    recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
    components: sharedComponents(),
    paidOrderDueAt: null,
    orderShortfallUnits: 0,
    ownerPriority: 0,
    forecastStockoutAt: null,
    salesVelocity: "0",
    ...overrides,
  };
}

function request(
  demands: readonly ProductionDemand[],
  available: Record<string, string>,
): AllocationRequest {
  return { demands, availableByItem: available, lossEnabled: true };
}

describe("allocateProduction", () => {
  it("does not promise the same shared wax to two scents", () => {
    // Wax for exactly 10 candles, but 8 + 8 requested.
    const result = allocateProduction(
      request(
        [
          demand({ finishedItemId: LAVENDER, requestedUnits: 8, ownerPriority: 10 }),
          demand({ finishedItemId: CEDAR, requestedUnits: 8, ownerPriority: 5 }),
        ],
        { [WAX]: oz("157"), [VESSEL]: "100" },
      ),
    );
    expect(result.lines.map((line) => line.allocatedUnits)).toEqual([8, 2]);
    expect(result.residualByItem[WAX]).toBe("0");
  });

  it("leaves nothing over-allocated when demand exactly consumes supply", () => {
    const result = allocateProduction(
      request(
        [
          demand({ finishedItemId: LAVENDER, requestedUnits: 5, ownerPriority: 10 }),
          demand({ finishedItemId: CEDAR, requestedUnits: 5, ownerPriority: 5 }),
        ],
        { [WAX]: oz("157"), [VESSEL]: "10" },
      ),
    );
    expect(result.lines.map((line) => line.allocatedUnits)).toEqual([5, 5]);
    expect(result.residualByItem[VESSEL]).toBe("0");
  });

  it("marks a line blocked when nothing remains for it", () => {
    const result = allocateProduction(
      request(
        [
          demand({ finishedItemId: LAVENDER, requestedUnits: 10, ownerPriority: 10 }),
          demand({ finishedItemId: CEDAR, requestedUnits: 4, ownerPriority: 5 }),
        ],
        { [WAX]: oz("157"), [VESSEL]: "100" },
      ),
    );
    expect(result.lines[1]!.allocatedUnits).toBe(0);
    expect(result.lines[1]!.status).toBe("BLOCKED");
    expect(result.lines[1]!.blockers.map((b) => b.itemId)).toContain(WAX);
  });

  it("marks a partially satisfied line PARTIAL, not FULFILLED", () => {
    const result = allocateProduction(
      request(
        [
          demand({ finishedItemId: LAVENDER, requestedUnits: 8, ownerPriority: 10 }),
          demand({ finishedItemId: CEDAR, requestedUnits: 8, ownerPriority: 5 }),
        ],
        { [WAX]: oz("157"), [VESSEL]: "100" },
      ),
    );
    expect(result.lines[0]!.status).toBe("FULFILLED");
    expect(result.lines[1]!.status).toBe("PARTIAL");
  });

  describe("priority ordering", () => {
    it("puts an earlier paid order due date first", () => {
      const result = allocateProduction(
        request(
          [
            demand({
              finishedItemId: LAVENDER,
              requestedUnits: 10,
              paidOrderDueAt: "2026-09-01T00:00:00.000Z",
            }),
            demand({
              finishedItemId: CEDAR,
              requestedUnits: 10,
              paidOrderDueAt: "2026-08-20T00:00:00.000Z",
            }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      // Cedar is due sooner, so it wins the wax.
      expect(result.lines[0]!.finishedItemId).toBe(CEDAR);
      expect(result.lines[0]!.allocatedUnits).toBe(10);
    });

    it("prefers a demand with an existing order shortfall over one without", () => {
      const result = allocateProduction(
        request(
          [
            demand({ finishedItemId: LAVENDER, requestedUnits: 10, orderShortfallUnits: 0 }),
            demand({ finishedItemId: CEDAR, requestedUnits: 10, orderShortfallUnits: 3 }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      expect(result.lines[0]!.finishedItemId).toBe(CEDAR);
    });

    it("falls back to owner priority", () => {
      const result = allocateProduction(
        request(
          [
            demand({ finishedItemId: LAVENDER, requestedUnits: 10, ownerPriority: 1 }),
            demand({ finishedItemId: CEDAR, requestedUnits: 10, ownerPriority: 9 }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      expect(result.lines[0]!.finishedItemId).toBe(CEDAR);
    });

    it("falls back to an earlier forecast stockout", () => {
      const result = allocateProduction(
        request(
          [
            demand({
              finishedItemId: LAVENDER,
              requestedUnits: 10,
              forecastStockoutAt: "2026-10-01T00:00:00.000Z",
            }),
            demand({
              finishedItemId: CEDAR,
              requestedUnits: 10,
              forecastStockoutAt: "2026-08-25T00:00:00.000Z",
            }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      expect(result.lines[0]!.finishedItemId).toBe(CEDAR);
    });

    it("falls back to higher sales velocity", () => {
      const result = allocateProduction(
        request(
          [
            demand({ finishedItemId: LAVENDER, requestedUnits: 10, salesVelocity: "0.5" }),
            demand({ finishedItemId: CEDAR, requestedUnits: 10, salesVelocity: "4.25" }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      expect(result.lines[0]!.finishedItemId).toBe(CEDAR);
    });

    it("uses SKU as a deterministic final tie-breaker", () => {
      // Identical on every other axis: the result must still be stable.
      const build = () =>
        allocateProduction(
          request(
            [
              demand({ finishedItemId: AMBER, sku: "SKU-ZZZ", requestedUnits: 10 }),
              demand({ finishedItemId: CEDAR, sku: "SKU-AAA", requestedUnits: 10 }),
            ],
            { [WAX]: oz("157"), [VESSEL]: "100" },
          ),
        );
      expect(build().lines[0]!.sku).toBe("SKU-AAA");
      // Same input, same output, every time.
      expect(build().lines.map((l) => l.sku)).toEqual(build().lines.map((l) => l.sku));
    });

    it("does not let a later due date jump ahead on owner priority", () => {
      // Due date outranks owner priority; a high manual priority must not
      // override a paid commitment that is due sooner.
      const result = allocateProduction(
        request(
          [
            demand({
              finishedItemId: LAVENDER,
              requestedUnits: 10,
              paidOrderDueAt: "2026-08-20T00:00:00.000Z",
              ownerPriority: 0,
            }),
            demand({ finishedItemId: CEDAR, requestedUnits: 10, ownerPriority: 99 }),
          ],
          { [WAX]: oz("157"), [VESSEL]: "100" },
        ),
      );
      expect(result.lines[0]!.finishedItemId).toBe(LAVENDER);
    });
  });

  describe("dry run", () => {
    it("reports the same numbers without claiming a reservation", () => {
      const built = request(
        [
          demand({ finishedItemId: LAVENDER, requestedUnits: 8, ownerPriority: 10 }),
          demand({ finishedItemId: CEDAR, requestedUnits: 8, ownerPriority: 5 }),
        ],
        { [WAX]: oz("157"), [VESSEL]: "100" },
      );
      const dry = allocateProduction({ ...built, dryRun: true });
      const live = allocateProduction(built);
      expect(dry.lines.map((l) => l.allocatedUnits)).toEqual(
        live.lines.map((l) => l.allocatedUnits),
      );
      expect(dry.reservable).toBe(false);
      expect(live.reservable).toBe(true);
    });
  });

  it("reports consumption per item so a caller can post reservations", () => {
    const result = allocateProduction(
      request([demand({ finishedItemId: LAVENDER, requestedUnits: 5 })], {
        [WAX]: oz("157"),
        [VESSEL]: "100",
      }),
    );
    expect(result.consumptionByItem[VESSEL]).toBe("5");
    expect(result.consumptionByItem[WAX]).toBe(oz("78.5"));
  });

  it("handles an empty plan without throwing", () => {
    const result = allocateProduction(request([], { [WAX]: oz("157") }));
    expect(result.lines).toEqual([]);
    expect(result.residualByItem[WAX]).toBe(oz("157"));
  });

  it("ignores fulfillment-critical shortages when allocating production", () => {
    const withBox: RecipeComponent[] = [
      ...sharedComponents(),
      {
        itemId: "0199a200-0000-7000-8000-000000000008",
        perUnitBase: "1",
        dependencyClass: "FULFILLMENT_CRITICAL",
        loss: { mode: "NONE" },
        countable: true,
      },
    ];
    const result = allocateProduction(
      request(
        [demand({ finishedItemId: LAVENDER, requestedUnits: 5, components: withBox })],
        { [WAX]: oz("157"), [VESSEL]: "100", "0199a200-0000-7000-8000-000000000008": "0" },
      ),
    );
    expect(result.lines[0]!.allocatedUnits).toBe(5);
  });
});
