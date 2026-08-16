import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runInventoryLedgerContract } from "@simple-flame/persistence-contracts/contract";
import postgres, { type Sql } from "postgres";
import { afterAll } from "vitest";

import { startDisposablePostgres, type DisposablePostgres } from "../testing/podman-postgres.js";
import { PostgresInventoryLedgerRepository } from "./postgres-inventory-ledger.js";

/**
 * Runs the shared ledger contract against a REAL PostgreSQL 17 in a disposable
 * Podman container. An in-memory fake would not exercise what actually matters
 * here: numeric(24,8) exactness, the append-only trigger, the advisory lock,
 * and transactional rollback.
 */

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../drizzle/0001_inventory_ledger.sql", import.meta.url)),
  "utf8",
);

let container: DisposablePostgres | undefined;
let sql: Sql | undefined;

async function ensureStarted(): Promise<Sql> {
  if (sql) return sql;
  container = await startDisposablePostgres();
  sql = postgres(container.connectionUri, { max: 5, onnotice: () => {} });
  await sql.unsafe(MIGRATION);
  return sql;
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

runInventoryLedgerContract("PostgreSQL", async () => {
  const connection = await ensureStarted();
  return {
    repository: new PostgresInventoryLedgerRepository(connection),
    reset: async () => {
      // TRUNCATE bypasses the append-only trigger by design: this is a fixture
      // reset, not a production correction path.
      await connection.unsafe(
        "TRUNCATE inventory_ledger_entries, processed_commands RESTART IDENTITY CASCADE",
      );
      await connection.unsafe("ALTER SEQUENCE inventory_revision_seq RESTART WITH 1");
    },
    dispose: async () => {
      /* container is shared across the suite and removed in afterAll */
    },
  };
});
