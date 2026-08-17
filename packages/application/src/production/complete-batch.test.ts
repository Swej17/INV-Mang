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
    it("accepts an override that draws the required total", async () => {
      const result = await useCase().execute(
        input({
          lotOverrides: { [WAX]: [{ lotId: "lot-manual", quantity: oz("157") }] },
        }),
      );
      expect(result.lotsByItem[WAX]!.map((d) => d.lotId)).toEqual(["lot-manual"]);
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
  });

  it("uses the caller's commandId so a retry is idempotent", async () => {
    await useCase().execute(input());
    expect(ledger.appended[0]!.commandId).toBe(COMMAND);
  });
});
