import { beforeEach, describe, expect, it } from "vitest";

import { convertQuantity, type Lot, type RecipeComponent } from "@simple-flame/domain";
import type {
  AppendResult,
  InventoryLedgerRepository,
  LedgerEntryDraft,
  LedgerEntryRecord,
  ProjectionRecord,
} from "@simple-flame/persistence-contracts";

import {
  CompleteProductionBatch,
  type RecipeVersionSnapshot,
} from "./complete-batch.js";

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const BOX = "0199a200-0000-7000-8000-000000000008";
const FINISHED = "0199a200-0000-7000-8000-0000000000b1";
const RECIPE = "0199a200-0000-7000-8000-0000000000a1";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";
const BATCH = "0199a500-0000-7000-8000-000000000001";
const COMMAND = "0199a500-0000-7000-8000-0000000000c1";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

/** Records what was appended so tests can assert atomicity and content. */
class FakeLedger implements InventoryLedgerRepository {
  appended: { commandId: string; entries: readonly LedgerEntryDraft[] }[] = [];
  failOnAppend: Error | null = null;

  async appendOnce(
    commandId: string,
    _organizationId: string,
    entries: readonly LedgerEntryDraft[],
  ): Promise<AppendResult> {
    if (this.failOnAppend) throw this.failOnAppend;
    this.appended.push({ commandId, entries });
    return { revision: String(this.appended.length), duplicate: false, entries: [] };
  }
  async getProjection(): Promise<ProjectionRecord> {
    throw new Error("not used");
  }
  async listEntries(): Promise<readonly LedgerEntryRecord[]> {
    return [];
  }
}

function components(overrides: Partial<RecipeComponent>[] = []): RecipeComponent[] {
  const base: RecipeComponent[] = [
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
  return overrides.length > 0 ? base.map((c, i) => ({ ...c, ...overrides[i] })) : base;
}

let ledger: FakeLedger;
let recipe: RecipeVersionSnapshot;
let lots: Record<string, Lot[]>;

function useCase(): CompleteProductionBatch {
  return new CompleteProductionBatch({
    recipes: { findVersion: async (id) => (id === RECIPE ? recipe : null) },
    lots: { listAvailable: async (itemId) => lots[itemId] ?? [] },
    ledger,
    clock: { now: () => "2026-08-16T12:00:00.000Z" },
  });
}

function input(overrides: Partial<Parameters<CompleteProductionBatch["execute"]>[0]> = {}) {
  return {
    commandId: COMMAND,
    organizationId: ORG,
    batchId: BATCH,
    recipeVersionId: RECIPE,
    locationId: LOCATION,
    finishedUnits: 10,
    lossEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  ledger = new FakeLedger();
  recipe = {
    recipeVersionId: RECIPE,
    finishedItemId: FINISHED,
    active: true,
    components: components(),
  };
  lots = {
    [WAX]: [{ lotId: "lot-a", receivedDate: "2026-08-01", bestByDate: null, remaining: oz("500") }],
    [VESSEL]: [{ lotId: "lot-v", receivedDate: "2026-08-01", bestByDate: null, remaining: "100" }],
  };
});

describe("CompleteProductionBatch", () => {
  it("posts consumption and finished output in ONE command", async () => {
    await useCase().execute(input());
    // Atomicity depends on this: two appends could half-commit.
    expect(ledger.appended).toHaveLength(1);
    const causes = ledger.appended[0]!.entries.map((e) => e.cause);
    expect(causes).toContain("PRODUCTION_CONSUMPTION");
    expect(causes).toContain("PRODUCTION_OUTPUT");
  });

  it("consumes exactly the recipe quantity", async () => {
    await useCase().execute(input());
    const wax = ledger.appended[0]!.entries.find(
      (e) => e.itemId === WAX && e.cause === "PRODUCTION_CONSUMPTION",
    );
    expect(wax!.onHandDelta).toBe(`-${oz("157")}`);
  });

  it("creates the finished goods", async () => {
    await useCase().execute(input());
    const output = ledger.appended[0]!.entries.find((e) => e.cause === "PRODUCTION_OUTPUT");
    expect(output!.itemId).toBe(FINISHED);
    expect(output!.onHandDelta).toBe("10");
  });

  it("records process loss separately from consumption", async () => {
    recipe = {
      ...recipe,
      components: components([{ loss: { mode: "PERCENT_PER_UNIT", percentage: "0.1" } }, {}]),
    };
    const result = await useCase().execute(input());
    const entries = ledger.appended[0]!.entries;
    const consumption = entries.find(
      (e) => e.itemId === WAX && e.cause === "PRODUCTION_CONSUMPTION",
    );
    const loss = entries.find((e) => e.itemId === WAX && e.cause === "PROCESS_LOSS");
    // Consumption is what became product; loss is waste. Blurring them would
    // misstate yield.
    expect(consumption!.onHandDelta).toBe(`-${oz("157")}`);
    expect(loss).toBeDefined();
    expect(result.lossByItem[WAX]).toBe(oz("15.7"));
  });

  it("posts no loss entry when loss is disabled", async () => {
    recipe = {
      ...recipe,
      components: components([{ loss: { mode: "PERCENT_PER_UNIT", percentage: "0.1" } }, {}]),
    };
    await useCase().execute(input({ lossEnabled: false }));
    expect(ledger.appended[0]!.entries.some((e) => e.cause === "PROCESS_LOSS")).toBe(false);
  });

  it("records source lots for traceability", async () => {
    const result = await useCase().execute(input());
    expect(result.lotsByItem[WAX]!.map((d) => d.lotId)).toEqual(["lot-a"]);
    // Quantities too: ids alone do not say how much came from where.
    expect(result.lotsByItem[WAX]!.map((d) => d.quantity)).toEqual([oz("157")]);
  });

  it("refuses to consume a lot-controlled item with no registered lots", async () => {
    // Previously: one gram of registered lot was correctly refused, but ZERO
    // registered lots consumed 4.45 kg and reported success with lots: [].
    recipe = { ...recipe, lotControlledItemIds: [WAX] };
    lots = { ...lots, [WAX]: [] };
    await expect(useCase().execute(input())).rejects.toThrow("cannot record traceability");
    expect(ledger.appended).toHaveLength(0);
  });

  it("still allows an item that is not lot controlled to have no lots", async () => {
    lots = { ...lots, [WAX]: [] };
    await expect(useCase().execute(input())).resolves.toBeDefined();
  });

  it("posts process loss as a NEGATIVE delta", async () => {
    // The sign was never asserted: a positive loss entry would have loss
    // creating stock, and only an unrelated integration total caught it.
    recipe = {
      ...recipe,
      components: components([{ loss: { mode: "PERCENT_PER_UNIT", percentage: "0.1" } }, {}]),
    };
    await useCase().execute(input());
    const loss = ledger.appended[0]!.entries.find(
      (e) => e.itemId === WAX && e.cause === "PROCESS_LOSS",
    );
    expect(loss!.onHandDelta).toBe(`-${oz("15.7")}`);
  });

  it("rolls back every consumption when the append fails", async () => {
    ledger.failOnAppend = new Error("finished item unavailable");
    await expect(useCase().execute(input())).rejects.toThrow("finished item unavailable");
    // Nothing partially applied: the single append is the transaction boundary.
    expect(ledger.appended).toHaveLength(0);
  });

  it("refuses a retired recipe version", async () => {
    recipe = { ...recipe, active: false };
    await expect(useCase().execute(input())).rejects.toThrow("is retired");
    expect(ledger.appended).toHaveLength(0);
  });

  it("refuses an unknown recipe version", async () => {
    await expect(
      useCase().execute(input({ recipeVersionId: "0199a200-0000-7000-8000-00000000dead" })),
    ).rejects.toThrow("unknown recipe version");
  });

  it.each([[0], [-1], [1.5]])("refuses a finishedUnits of %s", async (units) => {
    await expect(useCase().execute(input({ finishedUnits: units }))).rejects.toThrow(
      "positive integer",
    );
    expect(ledger.appended).toHaveLength(0);
  });

  it("ignores fulfillment-critical components", async () => {
    recipe = {
      ...recipe,
      components: [
        ...components(),
        {
          itemId: BOX,
          perUnitBase: "1",
          dependencyClass: "FULFILLMENT_CRITICAL",
          loss: { mode: "NONE" },
          countable: true,
        },
      ],
    };
    await useCase().execute(input());
    // A shipping box is consumed at fulfillment, not at production.
    expect(ledger.appended[0]!.entries.some((e) => e.itemId === BOX)).toBe(false);
  });

  describe("lot overrides", () => {
    it("accepts an override naming a real lot", async () => {
      const result = await useCase().execute(
        input({ lotOverrides: { [WAX]: [{ lotId: "lot-a", quantity: oz("157") }] } }),
      );
      expect(result.lotsByItem[WAX]!.map((d) => d.lotId)).toEqual(["lot-a"]);
    });

    it("refuses an override naming a lot that does not exist", async () => {
      // The total was validated but the lots were not, so an override could
      // point the traceability record at nothing.
      await expect(
        useCase().execute({
          ...input(),
          lotOverrides: { [WAX]: [{ lotId: "lot-that-never-existed", quantity: oz("157") }] },
        }),
      ).rejects.toThrow("unknown lot");
      expect(ledger.appended).toHaveLength(0);
    });

    it("flags an override as a manual departure from FIFO", async () => {
      await useCase().execute(
        input({ lotOverrides: { [WAX]: [{ lotId: "lot-a", quantity: oz("157") }] } }),
      );
      const consumption = ledger.appended[0]!.entries.find(
        (e) => e.itemId === WAX && e.cause === "PRODUCTION_CONSUMPTION",
      );
      expect(consumption!.metadata).toMatchObject({ manualOverride: true });
    });

    it("refuses an override that draws less than the recipe requires", async () => {
      // Consuming less than required would inflate yield and understate cost.
      await expect(
        useCase().execute(
          input({ lotOverrides: { [WAX]: [{ lotId: "lot-manual", quantity: oz("100") }] } }),
        ),
      ).rejects.toThrow("recipe requires");
      expect(ledger.appended).toHaveLength(0);
    });

    it("refuses an override that draws more than the recipe requires", async () => {
      await expect(
        useCase().execute(
          input({ lotOverrides: { [WAX]: [{ lotId: "lot-manual", quantity: oz("200") }] } }),
        ),
      ).rejects.toThrow("recipe requires");
    });

    describe("draw validation", () => {
      const LOT_A = "lot-a";
      const LOT_B = "lot-b";

      function draw(lotId: string, quantity: string) {
        return { lotId, quantity };
      }

      beforeEach(() => {
        // A component whose required quantity is a plain "5": keeps each
        // test's arithmetic about the draws under test, not unit conversion.
        recipe = {
          ...recipe,
          components: [
            {
              itemId: WAX,
              perUnitBase: "5",
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "NONE" },
              countable: false,
            },
          ],
        };
      });

      function run(overrides: Partial<Parameters<CompleteProductionBatch["execute"]>[0]> = {}) {
        return useCase().execute(input({ finishedUnits: 1, ...overrides }));
      }

      it("a negative draw cannot hide inside a correct total", async () => {
        // required 5; draws +7 and -2 total 5 exactly. Both lots have plenty
        // of remaining stock and neither lotId repeats, so only the negative
        // check can be what catches this.
        lots = {
          ...lots,
          [WAX]: [
            { lotId: LOT_A, receivedDate: "2026-08-01", bestByDate: null, remaining: "100" },
            { lotId: LOT_B, receivedDate: "2026-08-01", bestByDate: null, remaining: "100" },
          ],
        };
        await expect(
          run({ lotOverrides: { [WAX]: [draw(LOT_A, "7"), draw(LOT_B, "-2")] } }),
        ).rejects.toThrow(/negative/);
      });

      it("refuses a zero-quantity draw", async () => {
        // Zero is not negative, so assertNonNegativeDecimal alone would accept
        // it; a draw that takes nothing is still not a valid traceability record.
        lots = {
          ...lots,
          [WAX]: [{ lotId: LOT_A, receivedDate: "2026-08-01", bestByDate: null, remaining: "100" }],
        };
        await expect(
          run({ lotOverrides: { [WAX]: [draw(LOT_A, "0"), draw(LOT_B, "5")] } }),
        ).rejects.toThrow(/zero/);
      });

      it("the same lot cannot be drawn twice in one override", async () => {
        // 3 + 2 totals the required 5 exactly, and both draws individually fit
        // within the lot's remaining stock, so only the duplicate check can be
        // what catches this.
        lots = {
          ...lots,
          [WAX]: [{ lotId: LOT_A, receivedDate: "2026-08-01", bestByDate: null, remaining: "100" }],
        };
        await expect(
          run({ lotOverrides: { [WAX]: [draw(LOT_A, "3"), draw(LOT_A, "2")] } }),
        ).rejects.toThrow(/duplicate/);
      });

      it("a draw cannot exceed the lot's remaining quantity", async () => {
        // LOT_A has 4 remaining; draw 5 from it. The draw is positive, the
        // total still matches what the recipe requires, and the lot is not
        // named twice, so only the remaining-quantity check can be what
        // catches this.
        lots = {
          ...lots,
          [WAX]: [{ lotId: LOT_A, receivedDate: "2026-08-01", bestByDate: null, remaining: "4" }],
        };
        await expect(run({ lotOverrides: { [WAX]: [draw(LOT_A, "5")] } })).rejects.toThrow(
          /exceeds/,
        );
      });
    });
  });

  it("uses the caller's commandId so a retry is idempotent", async () => {
    await useCase().execute(input());
    expect(ledger.appended[0]!.commandId).toBe(COMMAND);
  });
});

describe("countable components in the ledger", () => {
  /**
   * The consequence of `countable` that actually reaches storage.
   *
   * `requiredForUnits` decides the consumption delta posted to the ledger, and
   * the ledger is append-only. A fractional vessel written here is not a
   * display rounding issue — it is a permanent 0.05 of a jar in on-hand stock
   * that no later correction removes without a compensating entry.
   *
   * Consumption and process loss are posted separately, so these assert the
   * TOTAL movement rather than either field: the total is what the shelf
   * actually loses, and asserting one half would pass while the other drifted.
   */
  function totalMoved(itemId: string): string {
    return ledger
      .appended[0]!.entries.filter((entry) => entry.itemId === itemId)
      .reduce((sum, entry) => sum + Number(entry.onHandDelta), 0)
      .toString();
  }

  it("takes whole vessels off the shelf when breakage makes the total fractional", async () => {
    recipe = {
      ...recipe,
      components: components([
        {},
        {
          perUnitBase: "1",
          loss: { mode: "PERCENT_PER_UNIT", percentage: "0.005" },
          countable: true,
        },
      ]),
    };
    await useCase().execute(input({ finishedUnits: 10 }));
    // 10 x 1 x 1.005 = 10.05 vessels. You open eleven.
    expect(totalMoved(VESSEL)).toBe("-11");
  });

  it("splits that whole number into consumption and loss without inventing a fraction", async () => {
    // Both halves must stay whole too: rounding only the total would leave
    // 10 consumed + 1.05 lost, which is the same fractional jar in a new place.
    recipe = {
      ...recipe,
      components: components([
        {},
        {
          perUnitBase: "1",
          loss: { mode: "PERCENT_PER_UNIT", percentage: "0.005" },
          countable: true,
        },
      ]),
    };
    await useCase().execute(input({ finishedUnits: 10 }));
    const vessels = ledger.appended[0]!.entries.filter((entry) => entry.itemId === VESSEL);
    expect(vessels.map((entry) => [entry.cause, entry.onHandDelta])).toEqual([
      ["PRODUCTION_CONSUMPTION", "-10"],
      ["PROCESS_LOSS", "-1"],
    ]);
  });

  it("still takes wax to the gram under the same loss policy", async () => {
    // The twin: identical loss on a non-countable component must stay exact,
    // or the rule has been applied to everything rather than to countables.
    recipe = {
      ...recipe,
      components: components([
        {
          perUnitBase: "100",
          loss: { mode: "PERCENT_PER_UNIT", percentage: "0.005" },
          countable: false,
        },
        {},
      ]),
    };
    await useCase().execute(input({ finishedUnits: 10 }));
    expect(totalMoved(WAX)).toBe("-1005");
  });
});
