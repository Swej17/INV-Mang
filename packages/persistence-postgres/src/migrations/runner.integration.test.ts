import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDisposableDatabase, type DisposableDatabase } from "../testing/disposable-postgres.js";
import {
  MIGRATION_LOCK_KEY,
  MigrationChecksumError,
  migrate,
  migrateTo,
  migrateToHead,
  type AppliedMigration,
} from "./runner.js";

/**
 * Runs the migration runner against a REAL PostgreSQL 17 database.
 *
 * Everything worth proving here is a database behaviour: transactional DDL,
 * the advisory lock, and the tracking row committing with the migration it
 * records. None of it survives a fake.
 */

/** The versions shipped in `drizzle/`. 0005 is deliberately absent (see spec). */
const HEAD_VERSIONS = ["0001", "0002", "0003", "0004", "0006", "0007", "0008"] as const;

let db: DisposableDatabase;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  db = await createDisposableDatabase();
});

afterEach(async () => {
  await db.drop();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeMigration(directory: string, name: string, body: string): void {
  writeFileSync(path.join(directory, name), body, "utf8");
}

/** A throwaway migration directory, so a case can control the file contents. */
function tempMigrations(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "sf-migration-runner-"));
  temporaryDirectories.push(directory);
  for (const [name, body] of Object.entries(files)) writeMigration(directory, name, body);
  return directory;
}

async function tableExists(name: string): Promise<boolean> {
  const [row] = await db.sql`SELECT to_regclass(${name}) IS NOT NULL AS present`;
  return row!["present"] as boolean;
}

async function recordedVersions(): Promise<readonly string[]> {
  const rows = await db.sql`SELECT version FROM schema_migrations ORDER BY version`;
  return rows.map((row) => row["version"] as string);
}

describe("migrating a database to head", () => {
  it("applies every shipped migration and records each one", async () => {
    const applied = await migrateToHead(db.sql);

    expect(applied.map((migration) => migration.version)).toEqual([...HEAD_VERSIONS]);
    expect(applied.every((migration) => !migration.alreadyApplied)).toBe(true);
    expect(await recordedVersions()).toEqual([...HEAD_VERSIONS]);
  });

  it("applies nothing on a second run", async () => {
    await migrateToHead(db.sql);
    const second = await migrateToHead(db.sql);

    expect(second.map((migration) => migration.version)).toEqual([...HEAD_VERSIONS]);
    expect(second.every((migration) => migration.alreadyApplied)).toBe(true);
    // Still one row per version: a re-run must not append a second record.
    expect(await recordedVersions()).toEqual([...HEAD_VERSIONS]);
  });

  it("applies only what is missing from a partially migrated database", async () => {
    const first = await migrateTo(db.sql, "0003");
    expect(first.map((migration) => migration.version)).toEqual(["0001", "0002", "0003"]);
    expect(await recordedVersions()).toEqual(["0001", "0002", "0003"]);

    const rest = await migrateToHead(db.sql);

    expect(
      rest.filter((migration) => !migration.alreadyApplied).map((migration) => migration.version),
    ).toEqual(["0004", "0006", "0007", "0008"]);
    expect(await recordedVersions()).toEqual([...HEAD_VERSIONS]);
  });

  it("refuses a target version that does not exist", async () => {
    await expect(migrateTo(db.sql, "9999")).rejects.toThrow(/9999/);
    // Refused before touching the database at all.
    expect(await tableExists("schema_migrations")).toBe(false);
  });
});

describe("a migration that changed on disk after it was applied", () => {
  /**
   * The pending file is ordered BEFORE the changed one deliberately. Two
   * branches merging out of order is how a back-dated migration appears, and it
   * is the only arrangement that distinguishes the two validation strategies:
   * validating the whole set up front refuses the run outright, while
   * validating each migration as the loop reaches it would apply 0001 first and
   * only then notice 0002 — leaving the database half-migrated, which is
   * exactly what the up-front rule exists to prevent.
   */
  async function stageAChangedMigration(): Promise<string> {
    const directory = tempMigrations({ "0002_ledger.sql": "CREATE TABLE ledger (label text);" });
    await migrate(db.sql, { directory });

    writeMigration(directory, "0001_audit.sql", "CREATE TABLE audit (id int);");
    writeMigration(directory, "0002_ledger.sql", "CREATE TABLE ledger (label text, note int);");
    return directory;
  }

  it("refuses the run, naming the file that changed", async () => {
    const directory = await stageAChangedMigration();

    const failure = await migrate(db.sql, { directory }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationChecksumError);
    // The unchanged 0001 is the other candidate; naming 0002 is the claim.
    expect((failure as MigrationChecksumError).version).toBe("0002");
    expect((failure as MigrationChecksumError).migrationName).toBe("0002_ledger.sql");
    // `name` identifies the error TYPE — it is what loggers and
    // Error.prototype.toString() print. The filename has its own field.
    expect((failure as MigrationChecksumError).name).toBe("MigrationChecksumError");
    expect(String(failure)).toBe(
      "MigrationChecksumError: migration 0002_ledger.sql (version 0002) changed after it was applied; migrations are frozen once applied — correct it in a new migration",
    );
  });

  it("applies nothing before refusing", async () => {
    const directory = await stageAChangedMigration();

    await expect(migrate(db.sql, { directory })).rejects.toBeInstanceOf(MigrationChecksumError);

    expect(await tableExists("audit")).toBe(false);
    expect(await recordedVersions()).toEqual(["0002"]);
  });
});

describe("a migration that fails", () => {
  it("rolls back its own DDL and leaves earlier migrations recorded", async () => {
    // One transaction per migration, not one for the whole run: 0001 has to
    // survive 0002 failing.
    const directory = tempMigrations({
      "0001_ok.sql": "CREATE TABLE ok (id int);",
      "0002_broken.sql":
        "CREATE TABLE broken (label text); SELECT this_function_does_not_exist();",
    });

    await expect(migrate(db.sql, { directory })).rejects.toThrow(/0002_broken/);

    expect(await recordedVersions()).toEqual(["0001"]);
    expect(await tableExists("ok")).toBe(true);
    expect(await tableExists("broken")).toBe(false);
  });

  it("rolls its own DDL back when the tracking insert is what fails", async () => {
    // The migration body and the row recording it must commit or roll back
    // together. Staged by making the RECORD fail rather than the body: a
    // trigger refuses version 0002's tracking row, so a runner that recorded
    // outside the migration's transaction would leave `traceability` committed
    // and unrecorded — applied twice on the next run.
    const directory = tempMigrations({
      "0001_guard.sql": `
        CREATE FUNCTION refuse_second_record() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.version = '0002' THEN RAISE EXCEPTION 'tracking insert refused'; END IF;
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_second BEFORE INSERT ON schema_migrations
          FOR EACH ROW EXECUTE FUNCTION refuse_second_record();
      `,
      "0002_traceability.sql": "CREATE TABLE traceability (batch text);",
    });

    await expect(migrate(db.sql, { directory })).rejects.toThrow(/0002_traceability/);

    expect(await tableExists("traceability")).toBe(false);
    expect(await recordedVersions()).toEqual(["0001"]);
  });
});

describe("two runners against one database", () => {
  /**
   * Staged deterministically, following the pattern proven in
   * `database-guarantees.integration.test.ts`: a blocker holds the migration
   * lock on its own connection until BOTH runners are provably parked on it,
   * so they are guaranteed to have started before either could read
   * `schema_migrations`. Racing two runners and hoping for contention would
   * prove nothing.
   */
  async function waitUntilRunnersAreParked(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const [row] = await db.sql`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 0 AND objid = ${MIGRATION_LOCK_KEY}
      `;
      if ((row!["waiting"] as number) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`only ${expected - 1} or fewer runners parked on the migration lock`);
  }

  it("serialises them instead of double-applying", async () => {
    const blocker = postgres(db.connectionUri, { max: 1, onnotice: () => {} });
    // max: 1 on purpose — the runner must never need a second connection while
    // it holds a connection-scoped lock, or a pool of one would deadlock.
    const otherClient = postgres(db.connectionUri, { max: 1, onnotice: () => {} });
    await blocker`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    const runners: Promise<readonly AppliedMigration[]>[] = [
      migrateToHead(db.sql),
      migrateToHead(otherClient),
    ];

    try {
      await waitUntilRunnersAreParked(2);
      // Ending the blocker's session releases its advisory lock.
      await blocker.end({ timeout: 5 });
      const [first, second] = await Promise.all(runners);

      expect(first!.map((migration) => migration.version)).toEqual([...HEAD_VERSIONS]);
      expect(second!.map((migration) => migration.version)).toEqual([...HEAD_VERSIONS]);
      // Exactly one runner applied each version; the other found it recorded.
      const freshlyApplied = [...first!, ...second!]
        .filter((migration) => !migration.alreadyApplied)
        .map((migration) => migration.version)
        .sort();
      expect(freshlyApplied).toEqual([...HEAD_VERSIONS]);
      expect(await recordedVersions()).toEqual([...HEAD_VERSIONS]);
    } finally {
      await blocker.end({ timeout: 5 });
      await Promise.allSettled(runners);
      await otherClient.end({ timeout: 5 });
    }
  });
});
