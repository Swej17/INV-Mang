import { CompleteProductionBatch } from "@simple-flame/application";
import { convertQuantity, type RecipeComponent } from "@simple-flame/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createMigratedDatabase, type DisposableDatabase } from "../testing/disposable-postgres.js";
import { PostgresInventoryLedgerRepository } from "./postgres-inventory-ledger.js";

/**
 * Batch completion against REAL PostgreSQL.
 *
 * The fake-ledger unit tests prove the use case emits one command. Only a real
 * database proves that command is genuinely atomic — that a failure partway
 * leaves no consumption behind, and that the append-only trigger and numeric
 * constraints hold under an actual transaction.
 */

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const FINISHED = "0199a200-0000-7000-8000-0000000000b1";
const RECIPE = "0199a200-0000-7000-8000-0000000000a1";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

let database: DisposableDatabase;

const components: RecipeComponent[] = [
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

function useCase(): CompleteProductionBatch {
  return new CompleteProductionBatch({
    recipes: {
      findVersion: async () => ({
        recipeVersionId: RECIPE,
        finishedItemId: FINISHED,
        active: true,
        components,
      }),
    },
    lots: { listAvailable: async () => [] },
    ledger: new PostgresInventoryLedgerRepository(database.sql),
    clock: { now: () => "2026-08-16T12:00:00.000Z" },
  });
}

beforeEach(async () => {
  if (!database) {
    database = await createMigratedDatabase();
  }
  await database.sql.unsafe(
    "TRUNCATE inventory_ledger_entries, processed_commands RESTART IDENTITY CASCADE",
  );
  await database.sql.unsafe("ALTER SEQUENCE inventory_revision_seq RESTART WITH 1");
  // Seed stock so a batch has something to consume.
  await new PostgresInventoryLedgerRepository(database.sql).appendOnce(
    "0199a500-0000-7000-8000-00000000seed".replace("seed", "0001"),
    ORG,
    [
      {
        itemId: WAX,
        locationId: LOCATION,
        cause: "RECEIPT",
        onHandDelta: oz("500"),
        reservedDelta: "0",
        incomingDelta: "0",
        occurredAt: "2026-08-15T00:00:00.000Z",
      },
      {
        itemId: VESSEL,
        locationId: LOCATION,
        cause: "RECEIPT",
        onHandDelta: "100",
        reservedDelta: "0",
        incomingDelta: "0",
        occurredAt: "2026-08-15T00:00:00.000Z",
      },
    ],
  );
});

afterAll(async () => {
  await database?.drop();
});

describe("production batch atomicity against real PostgreSQL", () => {
  it("consumes material and creates finished goods in one transaction", async () => {
    const ledger = new PostgresInventoryLedgerRepository(database.sql);
    await useCase().execute({
      commandId: "0199a500-0000-7000-8000-000000000101",
      organizationId: ORG,
      batchId: "0199a500-0000-7000-8000-000000000201",
      recipeVersionId: RECIPE,
      locationId: LOCATION,
      finishedUnits: 10,
      lossEnabled: true,
    });

    // 500 oz received, 157 oz consumed. Deltas are stored at numeric(24,8), so
    // oz(157) = 4450.875130625 lands as 4450.87513063 and the running total is
    // 14174.7615625 - 4450.87513063. Quantising each delta is NOT the same as
    // quantising the sum, which is why this is not simply oz("343").
    expect((await ledger.getProjection(ORG, WAX, LOCATION)).onHand).toBe("9723.88643187");
    expect((await ledger.getProjection(ORG, VESSEL, LOCATION)).onHand).toBe("90");
    expect((await ledger.getProjection(ORG, FINISHED, LOCATION)).onHand).toBe("10");
  });

  it("leaves NOTHING behind when the batch exceeds available material", async () => {
    const ledger = new PostgresInventoryLedgerRepository(database.sql);
    const before = await ledger.getProjection(ORG, WAX, LOCATION);

    await expect(
      useCase().execute({
        commandId: "0199a500-0000-7000-8000-000000000102",
        organizationId: ORG,
        batchId: "0199a500-0000-7000-8000-000000000202",
        recipeVersionId: RECIPE,
        locationId: LOCATION,
        finishedUnits: 1000,
        lossEnabled: true,
      }),
    ).rejects.toThrow();

    // The critical assertion: wax must be untouched. A partial batch would have
    // consumed wax with no candles to show for it.
    expect((await ledger.getProjection(ORG, WAX, LOCATION)).onHand).toBe(before.onHand);
    expect((await ledger.getProjection(ORG, FINISHED, LOCATION)).onHand).toBe("0");
  });

  it("is idempotent: replaying a batch command posts nothing new", async () => {
    const ledger = new PostgresInventoryLedgerRepository(database.sql);
    const command = "0199a500-0000-7000-8000-000000000103";
    const run = () =>
      useCase().execute({
        commandId: command,
        organizationId: ORG,
        batchId: "0199a500-0000-7000-8000-000000000203",
        recipeVersionId: RECIPE,
        locationId: LOCATION,
        finishedUnits: 5,
        lossEnabled: true,
      });

    await run();
    await run();

    // Five candles, not ten. A retried completion must not double production.
    expect((await ledger.getProjection(ORG, FINISHED, LOCATION)).onHand).toBe("5");
    // 5 candles: oz(78.5) = 2225.4375653125 stores as 2225.43756531.
    expect((await ledger.getProjection(ORG, WAX, LOCATION)).onHand).toBe("11949.32399719");
  });

  it("records loss as a separate ledger entry", async () => {
    const lossy: RecipeComponent[] = [
      { ...components[0]!, loss: { mode: "PERCENT_PER_UNIT", percentage: "0.1" } },
      components[1]!,
    ];
    const batch = new CompleteProductionBatch({
      recipes: {
        findVersion: async () => ({
          recipeVersionId: RECIPE,
          finishedItemId: FINISHED,
          active: true,
          components: lossy,
        }),
      },
      lots: { listAvailable: async () => [] },
      ledger: new PostgresInventoryLedgerRepository(database.sql),
      clock: { now: () => "2026-08-16T12:00:00.000Z" },
    });

    await batch.execute({
      commandId: "0199a500-0000-7000-8000-000000000104",
      organizationId: ORG,
      batchId: "0199a500-0000-7000-8000-000000000204",
      recipeVersionId: RECIPE,
      locationId: LOCATION,
      finishedUnits: 10,
      lossEnabled: true,
    });

    const entries = await new PostgresInventoryLedgerRepository(database.sql).listEntries(ORG, WAX);
    const causes = entries.map((e) => e.cause);
    expect(causes).toContain("PRODUCTION_CONSUMPTION");
    expect(causes).toContain("PROCESS_LOSS");
    // 157 oz consumed + 15.7 oz lost, from 500 oz received, each stored at
    // numeric(24,8): 14174.7615625 - 4450.87513063 - 445.08751306.
    expect((await new PostgresInventoryLedgerRepository(database.sql).getProjection(ORG, WAX, LOCATION)).onHand)
      .toBe("9278.79891881");
  });
});
