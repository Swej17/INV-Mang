# Migration Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the repo a migration runner that records what it applied, refuses to run edited migrations, and lets every integration test and CI job work against the real schema.

**Architecture:** Three units in `packages/persistence-postgres/src/migrations/` — discovery (filesystem → ordered list), runner (ordered list + database → applied), and a `schema_migrations` tracking table the runner creates itself. A thin CLI wraps the runner. Tasks 1 → 2 are sequential; Tasks 3 and 4 both depend on 2 and are independent of each other.

**Tech Stack:** TypeScript (node16 module resolution, `.js` import specifiers), `postgres.js`, vitest, PostgreSQL 17 (native, `postgres:postgres@127.0.0.1:5432`), `node:crypto` for SHA-256.

**Spec:** `docs/superpowers/specs/2026-08-20-migration-runner-design.md` — read it; it carries the rationale this plan implements.

## Global Constraints

- `corepack pnpm` always, never bare `pnpm`. Every worktree starts with `corepack pnpm install --frozen-lockfile`.
- Gates before every commit: `corepack pnpm test`, `corepack pnpm typecheck` (a SEPARATE gate — passing tests do not imply passing typecheck), `corepack pnpm lint`, `corepack pnpm check:boundaries`. Integration work also runs `cd packages/persistence-postgres && corepack pnpm vitest run --config vitest.integration.config.ts`.
- PostgreSQL 17 runs natively at `127.0.0.1:5432`, user and password `postgres` (set `PGPASSWORD=postgres`). Docker is prohibited; Podman cannot forward ports on this host. Integration tests use `createDisposableDatabase()`.
- TDD: failing test first, minimal implementation, then mutation-test every new invariant (break it one way, watch exactly the owning test fail, restore). A mutation that breaks nothing is a finding, not a pass.
- Fixture discipline (root `CLAUDE.md`): fixture values must disagree on every axis except the one under test. A test that would pass for a second reason is not evidence.
- Imports inside the package use `.js` specifiers (node16 resolution). Existing files show the pattern.
- Comments state invariants and rationale, never narration. Match the house style of the files you touch.
- Line endings: `.gitattributes` now enforces LF. Keep diffs minimal; never run `git add --renormalize`.
- Do NOT push and do NOT merge. Commit style: `feat:` / `fix:` / `test:` / `chore:`.

---

### Task 1: Migration discovery

**Branch:** `claude/migrations-discover`

**Files:**
- Create: `packages/persistence-postgres/src/migrations/discover.ts`
- Create: `packages/persistence-postgres/src/migrations/discover.test.ts`

**Interfaces:**
- Produces:
```ts
export type DiscoveredMigration = Readonly<{
  version: string;   // zero-padded as on disk, e.g. "0007"
  name: string;      // full filename, e.g. "0007_purchase_ordered_cause.sql"
  path: string;      // absolute path
}>;
export function discoverMigrations(directory: string): readonly DiscoveredMigration[];
export const MIGRATIONS_DIRECTORY: string; // absolute path to packages/persistence-postgres/drizzle
```
Task 2 consumes both. `discoverMigrations` reads the directory but NOT the file contents — the runner reads bodies, so discovery stays cheap and pure enough to unit-test against a temp directory.

- [ ] **Step 1: Write the failing tests.** Use `node:fs`'s `mkdtempSync` + `node:os`'s `tmpdir` to build directories per case; clean up in `afterEach`.

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverMigrations } from "./discover.js";

let dir: string;
function fixture(...names: string[]): string {
  dir = mkdtempSync(path.join(tmpdir(), "sf-migrations-"));
  for (const name of names) writeFileSync(path.join(dir, name), "SELECT 1;");
  return dir;
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test("orders by version and tolerates the deliberate 0005 gap", () => {
  // Deliberately written out of order on disk so a directory listing that
  // happened to be sorted could not produce this result by accident.
  const found = discoverMigrations(fixture("0006_auth.sql", "0001_ledger.sql", "0008_trace.sql"));
  expect(found.map((m) => m.version)).toEqual(["0001", "0006", "0008"]);
});

test("orders numerically, not lexicographically", () => {
  const found = discoverMigrations(fixture("0010_ten.sql", "0009_nine.sql"));
  expect(found.map((m) => m.version)).toEqual(["0009", "0010"]);
});

test("refuses two files claiming the same version", () => {
  expect(() => discoverMigrations(fixture("0007_a.sql", "0007_b.sql"))).toThrow(/duplicate/i);
});

test("refuses a malformed filename rather than skipping it", () => {
  // Skipping silently is how a migration gets left out of production.
  expect(() => discoverMigrations(fixture("0001_ledger.sql", "notes.sql"))).toThrow(/notes\.sql/);
});

test("ignores non-sql files", () => {
  const found = discoverMigrations(fixture("0001_ledger.sql", "README.md"));
  expect(found.map((m) => m.name)).toEqual(["0001_ledger.sql"]);
});

test("the shipped migrations directory resolves and is ordered", () => {
  const found = discoverMigrations(MIGRATIONS_DIRECTORY);
  expect(found.map((m) => m.version)).toEqual(["0001","0002","0003","0004","0006","0007","0008"]);
});
```

- [ ] **Step 2: Run, verify every test fails** (`discover.js` does not exist).

Run: `cd packages/persistence-postgres && corepack pnpm vitest run src/migrations/discover.test.ts`
Expected: FAIL, cannot resolve `./discover.js`.

- [ ] **Step 3: Implement.** Match `NNNN_name.sql`; sort by `Number(version)`; throw on duplicates and on any `.sql` file that does not match. Resolve `MIGRATIONS_DIRECTORY` with `fileURLToPath(new URL("../../drizzle", import.meta.url))` — the pattern the existing integration tests already use to reach `drizzle/`. Comment why gaps are legal (0005 is reserved; see the spec) and why a malformed name is fatal rather than skipped.

- [ ] **Step 4: Run tests, verify PASS.**

- [ ] **Step 5: Mutation-test each invariant.** Sort lexicographically → the numeric-ordering test fails. Drop the duplicate check → that test fails. Turn the malformed-name throw into a skip → that test fails. Restore after each; confirm each mutation kills exactly its own test.

- [ ] **Step 6: Full gates, then commit:** `feat: discover and order migration files`

---

### Task 2: The runner and its tracking table

**Branch:** `claude/migrations-runner` — branch from Task 1's merged result.

**Files:**
- Create: `packages/persistence-postgres/src/migrations/runner.ts`
- Create: `packages/persistence-postgres/src/migrations/runner.integration.test.ts`
- Modify: `packages/persistence-postgres/src/index.ts` (export the public surface)

**Interfaces:**
- Consumes: `discoverMigrations`, `MIGRATIONS_DIRECTORY`, `DiscoveredMigration` from Task 1.
- Produces:
```ts
export type AppliedMigration = Readonly<{ version: string; name: string; alreadyApplied: boolean }>;
export type MigrateOptions = Readonly<{ directory?: string; through?: string }>;
export function migrate(sql: Sql, options?: MigrateOptions): Promise<readonly AppliedMigration[]>;
export function migrateToHead(sql: Sql, directory?: string): Promise<readonly AppliedMigration[]>;
export function migrateTo(sql: Sql, through: string, directory?: string): Promise<readonly AppliedMigration[]>;
export class MigrationChecksumError extends Error {
  constructor(readonly version: string, readonly name: string);
}
```
Tasks 3 and 4 consume `migrateToHead` and `migrateTo`.

- [ ] **Step 1: Write the failing integration tests.** Follow the existing integration-test pattern: `createDisposableDatabase()` in `beforeEach`, `drop()` in `afterEach`. Build small throwaway migration directories with `mkdtempSync` for the cases that need controlled contents, and use `MIGRATIONS_DIRECTORY` for the real-schema case.

```ts
test("a fresh database reaches head and records every migration", async () => {
  const applied = await migrateToHead(db.sql);
  expect(applied.map((m) => m.version)).toEqual(["0001","0002","0003","0004","0006","0007","0008"]);
  expect(applied.every((m) => !m.alreadyApplied)).toBe(true);
  const [row] = await db.sql`SELECT count(*)::int AS n FROM schema_migrations`;
  expect(row.n).toBe(7);
});

test("re-running applies nothing", async () => {
  await migrateToHead(db.sql);
  const second = await migrateToHead(db.sql);
  expect(second.every((m) => m.alreadyApplied)).toBe(true);
  const [row] = await db.sql`SELECT count(*)::int AS n FROM schema_migrations`;
  expect(row.n).toBe(7);
});

test("a partially migrated database applies only what is missing", async () => {
  await migrateTo(db.sql, "0003");
  const rest = await migrateToHead(db.sql);
  expect(rest.filter((m) => !m.alreadyApplied).map((m) => m.version)).toEqual(["0004","0006","0007","0008"]);
});

test("an already-applied migration that changed on disk is refused", async () => {
  // Two files so the run has something legitimate to do; only the applied one
  // is edited, so a runner that ignored checksums would succeed here.
  const dir = tempMigrations({ "0001_a.sql": "CREATE TABLE a (id int);", "0002_b.sql": "CREATE TABLE b (id int);" });
  await migrate(db.sql, { directory: dir, through: "0001" });
  writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int, extra text);");
  await expect(migrate(db.sql, { directory: dir })).rejects.toBeInstanceOf(MigrationChecksumError);
  // Refused BEFORE applying anything: 0002 must not have run.
  const [row] = await db.sql`SELECT to_regclass('b') IS NOT NULL AS exists`;
  expect(row.exists).toBe(false);
});

test("a failing migration rolls back itself and leaves earlier ones recorded", async () => {
  const dir = tempMigrations({
    "0001_ok.sql": "CREATE TABLE ok (id int);",
    "0002_broken.sql": "CREATE TABLE broken (id int); SELECT this_function_does_not_exist();",
  });
  await expect(migrate(db.sql, { directory: dir })).rejects.toThrow(/0002_broken/);
  const versions = await db.sql`SELECT version FROM schema_migrations ORDER BY version`;
  expect(versions.map((r) => r.version)).toEqual(["0001"]);
  // The broken migration's own DDL rolled back with it.
  const [row] = await db.sql`SELECT to_regclass('broken') IS NOT NULL AS exists`;
  expect(row.exists).toBe(false);
});

test("two concurrent runners serialise rather than double-apply", async () => {
  // Staged deterministically: the blocker holds the advisory lock on its own
  // connection until the second runner is provably parked on it, following the
  // pattern in database-guarantees.integration.test.ts. Racing two runners and
  // hoping for contention would prove nothing.
  // ... acquire MIGRATION_LOCK_KEY on a separate connection, start migrateToHead,
  // poll pg_locks for the ungranted request, release, then await both.
  // Assert: 7 migrations applied in total, exactly one row per version.
});

test("an unknown target version is refused", async () => {
  await expect(migrateTo(db.sql, "9999")).rejects.toThrow(/9999/);
});
```

- [ ] **Step 2: Run, verify all fail.**

Run: `cd packages/persistence-postgres && corepack pnpm vitest run --config vitest.integration.config.ts src/migrations/runner.integration.test.ts`

- [ ] **Step 3: Implement.** In order:
  1. `ensureTrackingTable(sql)` — `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`. Comment why this table cannot live in a migration file: it is what decides whether migration files run.
  2. Take `pg_advisory_lock(MIGRATION_LOCK_KEY)` on a dedicated connection-scoped lock for the whole run, released in a `finally`. Use a fixed named constant with a comment; do NOT reuse the ledger's key.
  3. Read every discovered file's contents, compute `createHash("sha256").update(body).digest("hex")`.
  4. Validate the WHOLE set before applying anything: every recorded migration whose checksum differs from disk throws `MigrationChecksumError`; an unknown `through` version throws. Validation-before-application is what stops a bad directory leaving a half-migrated database.
  5. Apply each pending migration in its own `sql.begin()`, running the body with `tx.unsafe(body)` and inserting its `schema_migrations` row **in the same transaction** — a crash between them would leave a migration applied but unrecorded, and the next run would apply it twice.
  6. On failure, wrap the error naming the file, and rethrow.

- [ ] **Step 4: Run tests, verify PASS.**

- [ ] **Step 5: Export from `src/index.ts`** alongside the existing repository export.

- [ ] **Step 6: Mutation-test each invariant.** Move the tracking insert out of the migration's transaction → the rollback test fails. Skip checksum validation → that test fails. Validate lazily (per migration instead of up front) → the checksum test's `to_regclass('b')` assertion fails. Remove the advisory lock → the concurrency test fails. Restore each.

- [ ] **Step 7: Full gates including the integration config, then commit:** `feat: apply and record migrations with checksum and lock guards`

---

### Task 3: CLI entrypoint

**Branch:** `claude/migrations-cli` — branch from Task 2's merged result. Independent of Task 4.

**Files:**
- Create: `packages/persistence-postgres/bin/migrate.mjs`
- Modify: `packages/persistence-postgres/package.json` (add `bin`, add a `migrate` script)
- Modify: root `package.json` (add a `migrate` script delegating to the package)
- Create: `packages/persistence-postgres/bin/migrate.test.mjs` — spawn the CLI against a disposable database and assert on exit code and output.

**Interfaces:**
- Consumes: `migrateToHead` from Task 2.

- [ ] **Step 1: Write the failing test.** Spawn with `node:child_process`'s `execFile`; create the database with the existing disposable helper; assert exit 0, that stdout names each applied migration, and that a second run reports them as already applied. Add a case asserting a missing connection string exits non-zero with a message naming `DATABASE_URL` — a CLI that silently defaults to some local database is how the wrong database gets migrated.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** Read `--database-url` then `DATABASE_URL`; exit 2 with a clear message if neither is set. Connect with `postgres(uri, { max: 1, onnotice: () => {} })`, call `migrateToHead`, print one line per migration (`applied 0007_purchase_ordered_cause` / `skipped 0001_inventory_ledger (already applied)`), print a summary count, close the connection in a `finally`, and exit non-zero on any error with the message on stderr. Keep it thin: all behaviour lives in the library so there is no second place migration logic can drift.

- [ ] **Step 4: Run tests, verify PASS. Then run it by hand once** against a throwaway database and paste the real output into the report.

- [ ] **Step 5: Full gates, then commit:** `feat: add a migrate command`

---

### Task 4: Convert the tests, wire CI, record the new constraint

**Branch:** `claude/migrations-adopt` — branch from Task 2's merged result. Independent of Task 3.

**Files:**
- Modify: `packages/persistence-postgres/src/testing/disposable-postgres.ts`
- Modify: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.integration.test.ts`
- Modify: `packages/persistence-postgres/src/repositories/production-batch.integration.test.ts`
- Modify: `packages/persistence-postgres/src/repositories/traceability-integrity.integration.test.ts`
- Modify: `packages/persistence-postgres/src/repositories/database-guarantees.integration.test.ts`
- Modify: `apps/api/src/routes/commands.integration.test.ts`
- Modify: `apps/worker/src/runner.integration.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `migrateToHead`, `migrateTo` from Task 2.
- Produces: `createMigratedDatabase(): Promise<DisposableDatabase>` from `disposable-postgres.ts` — creates a disposable database already at head. `createDisposableDatabase()` keeps its current unmigrated behaviour, because Task 4's one deliberate exception still needs it.

- [ ] **Step 1: Add `createMigratedDatabase`** to `disposable-postgres.ts` — `createDisposableDatabase()` then `migrateToHead(db.sql)`. Comment that a test wanting a partial schema must say so explicitly.

- [ ] **Step 2: Convert the five subset call sites.** Replace each hand-rolled `migration("00NN_....sql")` list with `createMigratedDatabase()`, deleting the now-unused `migration()` helpers and `readFileSync` imports. Every one of these tests must still pass unchanged otherwise — if a test fails against the full schema, STOP and report it: that is a real defect this task found, not something to paper over.

- [ ] **Step 3: Keep the one deliberate exception.** In `database-guarantees.integration.test.ts`, the test that simulates upgrading an old database must keep starting below head. Convert it to `migrateTo(db.sql, "0001")` (plus whatever it genuinely needs) and add a comment: this test asserts an upgrade path, so it must NOT start at head; it is an opt-out with a reason, not a leftover subset.

- [ ] **Step 4: Run the whole integration suite. Verify PASS.**

Run: `cd packages/persistence-postgres && corepack pnpm vitest run --config vitest.integration.config.ts`, and the api and worker integration tests.

- [ ] **Step 5: Add PostgreSQL to CI.** In `.github/workflows/ci.yml`, add a `services: postgres:` block (image `postgres:17`, env `POSTGRES_PASSWORD: postgres`, a health check, port 5432) and a step running the integration suite with `PGPASSWORD=postgres`. Keep the existing unit step and its `--exclude` so unit and integration failures stay distinguishable. Update the comment that currently says integration tests wait on the migration runner — they no longer do; that is what this task delivered.

- [ ] **Step 6: Record the new contributor constraint in `CLAUDE.md`.** Once a migration has been applied anywhere, its file is frozen — the checksum guard refuses a changed file. Corrections go in a new migration. Keep it to a few lines in the existing conventions section.

- [ ] **Step 7: Full gates including integration, then commit:** `test: migrate every integration database to head` and `ci: run integration tests against PostgreSQL`

---

### Manager runbook (not delegated)

- [ ] **M-1:** Commit spec and plan to `phase1/integration`.
- [ ] **M-2:** Dispatch Task 1 (cheap model — complete code in the brief). Review, merge.
- [ ] **M-3:** Dispatch Task 2 (most capable model — transaction boundaries, lock semantics, checksum ordering). Review, merge.
- [ ] **M-4:** Dispatch Tasks 3 and 4 in parallel (own worktrees, disjoint files). Review each, merge 3 then 4.
- [ ] **M-5:** Full gate suite on the merged branch, including integration.
- [ ] **M-6:** Final whole-branch review over the combined diff.
- [ ] **M-7:** Update `docs/agent-handoff.md`: close backlog item 4, and correct the "CI does not run this branch's strongest new invariants" section — it now does.
- [ ] **M-8:** Push. Report.
