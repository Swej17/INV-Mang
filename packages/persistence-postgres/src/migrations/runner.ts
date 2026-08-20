import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ReservedSql, Sql } from "postgres";

import {
  MIGRATIONS_DIRECTORY,
  discoverMigrations,
  type DiscoveredMigration,
} from "./discover.js";

export type AppliedMigration = Readonly<{
  version: string;
  name: string;
  alreadyApplied: boolean;
}>;

export type MigrateOptions = Readonly<{ directory?: string; through?: string }>;

/**
 * The key every runner takes before touching a database.
 *
 * Fixed and arbitrary — the ASCII bytes of `_MIG`, so it is recognisable in
 * `pg_locks` — but it must never change: two runners agreeing on the key is the
 * whole guarantee. Deliberately its own constant rather than the ledger's
 * scheme, which hashes `organization:item:location` scopes into
 * transaction-scoped locks; sharing a key space with those would make an append
 * and a migration contend for reasons neither could explain.
 */
export const MIGRATION_LOCK_KEY = 0x5f_4d_49_47;

/**
 * An already-applied migration whose file no longer matches what was applied.
 *
 * Refusing is the whole behaviour: the runner cannot know whether the edit was
 * a typo fix or a semantic change, so it reports the file and stops.
 *
 * `name` deliberately carries the migration filename rather than the class
 * name, per the interface this task publishes; identify the error with
 * `instanceof`.
 */
export class MigrationChecksumError extends Error {
  constructor(
    readonly version: string,
    override readonly name: string,
  ) {
    super(
      `Migration ${name} has changed since it was applied. Applied migrations are append-only: restore the file, or apply the change as a new migration.`,
    );
  }
}

type LoadedMigration = DiscoveredMigration & Readonly<{ body: string; checksum: string }>;

export async function migrateToHead(
  sql: Sql,
  directory?: string,
): Promise<readonly AppliedMigration[]> {
  return migrate(sql, directory === undefined ? {} : { directory });
}

export async function migrateTo(
  sql: Sql,
  through: string,
  directory?: string,
): Promise<readonly AppliedMigration[]> {
  return migrate(sql, directory === undefined ? { through } : { directory, through });
}

/**
 * Applies every migration the database is missing, in version order.
 *
 * The ordering here is the correctness of the whole runner:
 *
 * 1. The WHOLE set is validated before anything is applied, so a directory
 *    that will be refused never leaves a database half-migrated.
 * 2. Each migration gets its OWN transaction. PostgreSQL has transactional
 *    DDL, so a failing migration rolls back on its own while every migration
 *    before it stays applied and recorded; one transaction around the run
 *    would throw away good work because a later file was broken.
 * 3. The tracking row is written in the SAME transaction as the migration body
 *    it records. Were they separate, a crash between them would leave a
 *    migration applied but unrecorded, and the next run would apply it twice.
 */
export async function migrate(
  sql: Sql,
  options: MigrateOptions = {},
): Promise<readonly AppliedMigration[]> {
  const directory = options.directory ?? MIGRATIONS_DIRECTORY;
  const selected = select(discoverMigrations(directory), options.through);
  const migrations = selected.map(load);

  // The lock is session-scoped, so it must be taken and released on ONE
  // connection: a pooled `sql` would hand the release to whichever connection
  // happened to be free and leave the lock held for the life of the pool.
  // Everything else runs on that same reserved connection too, so a pool of one
  // (what the CLI opens) cannot deadlock against its own lock.
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await ensureTrackingTable(connection);
      const recorded = await readRecorded(connection);
      assertNothingAppliedHasChanged(migrations, recorded);

      const results: AppliedMigration[] = [];
      for (const migration of migrations) {
        const alreadyApplied = recorded.has(migration.version);
        if (!alreadyApplied) await apply(connection, migration);
        results.push({
          version: migration.version,
          name: migration.name,
          alreadyApplied,
        });
      }
      return results;
    } finally {
      await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    connection.release();
  }
}

/** Narrows the discovered set to everything up to and including `through`. */
function select(
  discovered: readonly DiscoveredMigration[],
  through: string | undefined,
): readonly DiscoveredMigration[] {
  if (through === undefined) return discovered;

  const target = discovered.findIndex((migration) => migration.version === through);
  if (target === -1) {
    throw new Error(
      `Unknown migration version: ${through}. Known versions: ${discovered
        .map((migration) => migration.version)
        .join(", ")}`,
    );
  }
  return discovered.slice(0, target + 1);
}

/** Reads a migration's body once, so the checksum is of exactly what runs. */
function load(migration: DiscoveredMigration): LoadedMigration {
  const body = readFileSync(migration.path, "utf8");
  return { ...migration, body, checksum: createHash("sha256").update(body).digest("hex") };
}

/**
 * The tracking table cannot live in a migration file: it is what decides
 * whether migration files run at all. So the runner creates it itself, before
 * reading anything, and holds the advisory lock while doing so.
 */
async function ensureTrackingTable(connection: ReservedSql): Promise<void> {
  await connection`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function readRecorded(connection: ReservedSql): Promise<ReadonlyMap<string, string>> {
  const rows = await connection`SELECT version, checksum FROM schema_migrations`;
  return new Map(rows.map((row) => [row["version"] as string, row["checksum"] as string]));
}

/**
 * Checks EVERY applied migration up front rather than as the loop reaches it.
 * A pending migration ordered before a changed one — two branches merging out
 * of order — would otherwise be applied to a database the runner is about to
 * refuse to finish migrating.
 */
function assertNothingAppliedHasChanged(
  migrations: readonly LoadedMigration[],
  recorded: ReadonlyMap<string, string>,
): void {
  for (const migration of migrations) {
    const appliedChecksum = recorded.get(migration.version);
    // Versions recorded but absent from the directory are left alone: a
    // database ahead of the files is not this run's business.
    if (appliedChecksum === undefined || appliedChecksum === migration.checksum) continue;
    throw new MigrationChecksumError(migration.version, migration.name);
  }
}

/**
 * Runs one migration and records it in a single transaction.
 *
 * Explicit BEGIN/COMMIT rather than `sql.begin()`: the transaction has to run
 * on the connection already holding the advisory lock, and postgres.js does not
 * expose `begin()` on a reserved handle (its type says otherwise; the runtime
 * object has only the query methods).
 */
async function apply(connection: ReservedSql, migration: LoadedMigration): Promise<void> {
  await connection.unsafe("BEGIN");
  try {
    await connection.unsafe(migration.body);
    // Inside the same transaction as the body above: the migration and the row
    // saying it ran become true together or not at all.
    await connection`
      INSERT INTO schema_migrations (version, name, checksum)
      VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
    `;
    await connection.unsafe("COMMIT");
  } catch (error) {
    // A failing ROLLBACK means the connection itself is gone, which the
    // original error describes better than a rollback error would.
    await connection.unsafe("ROLLBACK").catch(() => undefined);
    throw new Error(`Migration ${migration.name} failed: ${messageOf(error)}`, { cause: error });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
