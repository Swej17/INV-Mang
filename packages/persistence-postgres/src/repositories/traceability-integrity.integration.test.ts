import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDisposableDatabase, type DisposableDatabase } from "../testing/disposable-postgres.js";

/**
 * The traceability records, against REAL PostgreSQL.
 *
 * production_batch_lots answers the only question a recall asks: which drum of
 * wax went into this candle. 0003 left it weaker than the ledger it explains —
 * freely mutable, and cascading from production_batches so one DELETE erased
 * every linkage while the PRODUCTION_CONSUMPTION entries survived. That is the
 * worst failure shape available: the numbers still balance, so nothing looks
 * wrong, and the answer to the recall question is simply gone.
 *
 * These are database guarantees, so only a database can prove them.
 */

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
}

let db: DisposableDatabase;

/** A batch with one traced lot. Returns the ids needed to attack it. */
async function seedTracedBatch(): Promise<{ batchId: string; lotId: string; traceId: string }> {
  const itemId = randomUUID();
  const finishedId = randomUUID();
  const recipeId = randomUUID();
  const commandId = randomUUID();
  const batchId = randomUUID();
  const lotId = randomUUID();
  const traceId = randomUUID();

  const items = [
    [itemId, "wax-" + itemId.slice(0, 8), "RAW_MATERIAL", "PRODUCTION_CRITICAL"],
    [finishedId, "candle-" + finishedId.slice(0, 8), "FINISHED_GOOD", "ADVISORY"],
  ] as const;
  for (const [id, sku, category, dependency] of items) {
    await db.sql`
      INSERT INTO inventory_items (id, organization_id, sku, name, category, dependency_class, base_unit)
      VALUES (${id}, ${ORG}, ${sku}, ${sku}, ${category}, ${dependency}, 'GRAM')
    `;
  }
  await db.sql`
    INSERT INTO recipe_versions (id, organization_id, finished_item_id, version, name)
    VALUES (${recipeId}, ${ORG}, ${finishedId}, 1, 'v1')
  `;
  await db.sql`
    INSERT INTO processed_commands (command_id, organization_id, result_json)
    VALUES (${commandId}, ${ORG}, '{}'::jsonb)
  `;
  await db.sql`
    INSERT INTO production_batches
      (id, organization_id, recipe_version_id, location_id, finished_item_id, finished_units, command_id)
    VALUES (${batchId}, ${ORG}, ${recipeId}, ${LOCATION}, ${finishedId}, 10, ${commandId})
  `;
  await db.sql`
    INSERT INTO inventory_lots
      (id, organization_id, item_id, location_id, received_date, received_quantity, remaining_quantity)
    VALUES (${lotId}, ${ORG}, ${itemId}, ${LOCATION}, '2026-08-01', 500, 500)
  `;
  await db.sql`
    INSERT INTO production_batch_lots (id, batch_id, item_id, lot_id, quantity)
    VALUES (${traceId}, ${batchId}, ${itemId}, ${lotId}, 157)
  `;
  return { batchId, lotId, traceId };
}

beforeEach(async () => {
  if (!db) {
    db = await createDisposableDatabase();
    await db.sql.unsafe(migration("0001_inventory_ledger.sql"));
    await db.sql.unsafe(migration("0002_items_recipes.sql"));
    await db.sql.unsafe(migration("0003_lots_production.sql"));
    await db.sql.unsafe(migration("0008_traceability_integrity.sql"));
  }
});

afterAll(async () => {
  await db?.drop();
});

describe("production_batch_lots is append-only", () => {
  it("refuses to change which lot a batch drew from", async () => {
    const { traceId } = await seedTracedBatch();
    const otherLot = randomUUID();
    await expect(
      db.sql`UPDATE production_batch_lots SET lot_id = ${otherLot} WHERE id = ${traceId}`,
    ).rejects.toThrow(/append-only/);
  });

  it("refuses to change how much was drawn", async () => {
    const { traceId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE production_batch_lots SET quantity = 1 WHERE id = ${traceId}`,
    ).rejects.toThrow(/append-only/);
  });

  it("refuses to delete a traceability record", async () => {
    const { traceId } = await seedTracedBatch();
    await expect(db.sql`DELETE FROM production_batch_lots WHERE id = ${traceId}`).rejects.toThrow(
      /append-only/,
    );
  });

  it("refuses to hide a manual override after the fact", async () => {
    // The column exists to be audited. Flipping it later is exactly the edit an
    // audit is meant to catch.
    const { traceId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE production_batch_lots SET manual_override = true WHERE id = ${traceId}`,
    ).rejects.toThrow(/append-only/);
  });
});

describe("a traced batch cannot be deleted", () => {
  it("refuses to delete the batch while its trace exists", async () => {
    // Under the original ON DELETE CASCADE this succeeded and silently took
    // every linkage with it.
    //
    // The error MATTERS here, not just the rejection. Mutation-testing this
    // with CASCADE restored showed the delete still fails — the append-only
    // trigger fires on the cascaded row — but it fails as "production_batch_lots
    // is append-only", an error about a table the operator never touched. The
    // two protections genuinely overlap; RESTRICT is kept because it refuses at
    // the level the operator acted on, and because it still holds if the
    // trigger is ever dropped. Asserting the foreign-key error is what tells
    // the two apart.
    const { batchId } = await seedTracedBatch();
    await expect(db.sql`DELETE FROM production_batches WHERE id = ${batchId}`).rejects.toThrow(
      /foreign key|violates/i,
    );
  });

  it("leaves the trace intact after the attempt", async () => {
    // Passes under either protection, deliberately: this asserts the outcome
    // the business depends on, not which mechanism delivered it.
    const { batchId, traceId } = await seedTracedBatch();
    await expect(db.sql`DELETE FROM production_batches WHERE id = ${batchId}`).rejects.toThrow();
    const rows = await db.sql`SELECT id FROM production_batch_lots WHERE id = ${traceId}`;
    expect(rows).toHaveLength(1);
  });

  it("still refuses to delete the lot a batch drew from", async () => {
    // 0003 already got this right by omitting ON DELETE; pinned here so a later
    // migration cannot quietly add a cascade to make a delete "work".
    const { lotId } = await seedTracedBatch();
    await expect(db.sql`DELETE FROM inventory_lots WHERE id = ${lotId}`).rejects.toThrow(
      /foreign key|violates/i,
    );
  });
});

describe("inventory_lots identity is immutable but its quantity is not", () => {
  it("allows the remaining quantity to fall as the lot is drawn from", async () => {
    // The lot table is deliberately NOT append-only. Locking it entirely would
    // break the FIFO draw-down it exists to support.
    const { lotId } = await seedTracedBatch();
    await db.sql`UPDATE inventory_lots SET remaining_quantity = 343 WHERE id = ${lotId}`;
    const rows = await db.sql`SELECT remaining_quantity FROM inventory_lots WHERE id = ${lotId}`;
    expect(Number(rows[0]!["remaining_quantity"])).toBe(343);
  });

  it("allows a best-by date correction from the supplier's paperwork", async () => {
    const { lotId } = await seedTracedBatch();
    await db.sql`UPDATE inventory_lots SET best_by_date = '2027-01-01' WHERE id = ${lotId}`;
    const rows = await db.sql`SELECT best_by_date FROM inventory_lots WHERE id = ${lotId}`;
    expect(rows[0]!["best_by_date"]).not.toBeNull();
  });

  it("refuses to re-point a lot at a different item", async () => {
    // Every finished candle already linked to this lot would silently start
    // claiming it was made from different material.
    const { lotId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE inventory_lots SET item_id = ${randomUUID()} WHERE id = ${lotId}`,
    ).rejects.toThrow(/identity is immutable/);
  });

  it("refuses to rewrite how much arrived", async () => {
    const { lotId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE inventory_lots SET received_quantity = 9999 WHERE id = ${lotId}`,
    ).rejects.toThrow(/identity is immutable/);
  });

  it("refuses to move a lot to another organization", async () => {
    const { lotId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE inventory_lots SET organization_id = ${randomUUID()} WHERE id = ${lotId}`,
    ).rejects.toThrow(/identity is immutable/);
  });

  it("refuses to backdate the receipt, which would reorder FIFO", async () => {
    const { lotId } = await seedTracedBatch();
    await expect(
      db.sql`UPDATE inventory_lots SET received_date = '2020-01-01' WHERE id = ${lotId}`,
    ).rejects.toThrow(/identity is immutable/);
  });
});
