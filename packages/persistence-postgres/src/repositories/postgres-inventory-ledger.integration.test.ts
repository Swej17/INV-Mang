import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runInventoryLedgerContract } from "@simple-flame/persistence-contracts/contract";
import { afterAll } from "vitest";

import { createDisposableDatabase, type DisposableDatabase } from "../testing/disposable-postgres.js";
import { PostgresInventoryLedgerRepository } from "./postgres-inventory-ledger.js";

/**
 * Runs the shared ledger contract against a REAL PostgreSQL 17 database.
 *
 * An in-memory fake would not exercise what actually matters here:
 * numeric(24,8) exactness, the append-only trigger, the advisory lock, and
 * transactional rollback.
 */

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../drizzle/0001_inventory_ledger.sql", import.meta.url)),
  "utf8",
);

let database: DisposableDatabase | undefined;

async function ensureStarted(): Promise<DisposableDatabase> {
  if (database) return database;
  database = await createDisposableDatabase();
  await database.sql.unsafe(MIGRATION);
  return database;
}

afterAll(async () => {
  await database?.drop();
});

runInventoryLedgerContract("PostgreSQL", async () => {
  const { sql } = await ensureStarted();
  return {
    repository: new PostgresInventoryLedgerRepository(sql),
    reset: async () => {
      // TRUNCATE bypasses the append-only trigger by design: this is a fixture
      // reset, not a production correction path.
      await sql.unsafe(
        "TRUNCATE inventory_ledger_entries, processed_commands RESTART IDENTITY CASCADE",
      );
      await sql.unsafe("ALTER SEQUENCE inventory_revision_seq RESTART WITH 1");
    },
    dispose: async () => {
      /* database is shared across the suite and dropped in afterAll */
    },
  };
});
