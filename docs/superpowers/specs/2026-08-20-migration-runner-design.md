# Migration runner — design

**Status:** approved 2026-08-20. Closes open backlog item 4 ("There is no migration runner").

## The problem

Migrations are applied only by hand, inside individual test files, each listing
the subset it happens to need. Nothing records which migrations a database has
had applied.

The subsets have already drifted apart:

| Test | Applies |
|---|---|
| `commands.integration.test.ts` | 0001, 0006 |
| `runner.integration.test.ts` | 0001, 0006 |
| `database-guarantees.integration.test.ts` | 0001, 0007 |
| `production-batch.integration.test.ts` | 0001, 0002, 0003 |
| `traceability-integrity.integration.test.ts` | 0001, 0002, 0003, 0008 |

Every one of those is a schema that could never exist in production. A test
passing against a partial schema proves nothing about the real one, and
`0007`/`0008` are `ALTER`s whose ordering is load-bearing.

This was tolerable while every migration was `CREATE TABLE IF NOT EXISTS`. It
is not tolerable now, and it blocks two things: any deployment at all, and
running integration tests in CI — where the 18 shared-contract cases in
`inventory-ledger.contract.ts` currently never execute.

## What was verified before designing

A throwaway probe applied all seven migrations in order to a fresh database,
then applied all seven again:

- First pass: all seven succeeded. 17 tables created.
- Second pass: all seven succeeded again — every file is currently idempotent,
  including the two `ALTER`-based ones, which guard with `DROP CONSTRAINT IF
  EXISTS` and `CREATE OR REPLACE`.

Two conclusions. Converting the tests to full migration should not surface
breakage — and if it does, that is a real bug this work found. And the
tracking table is not needed to stop today's files from breaking on re-run; it
is needed for the first file that is not idempotent.

## Scope

**In:** a migration library, a CLI entrypoint, conversion of every integration
test to full migration, and a PostgreSQL service in CI so the integration suite
runs there.

**Out, deliberately:**

- **Down-migrations / rollback.** There is no deploy process to roll back. A
  rollback story designed against a host nobody has chosen is speculation, and
  the wrong rollback is worse than none.
- **Dry-run mode.** `migrateTo(version)` already answers "what would happen".
- **Adopting drizzle-kit.** The repo deliberately uses raw SQL migrations with
  `postgres.js` (recorded backlog item 3). Changing that is a separate decision.

## Components

Three units, each independently testable.

### 1. Discovery — `src/migrations/discover.ts`

Reads `drizzle/*.sql`, parses the leading numeric version, returns them sorted
by version.

- **Gaps are legal.** `0005` is deliberately absent (reserved for orders/packing,
  which Task 8 did not deliver; `0006`'s header explains why). Sorting is by
  parsed number, so a gap is invisible to the runner. Renumbering would rewrite
  history to fix nothing.
- **Duplicate versions are fatal.** Two files claiming `0007` means an ambiguous
  order; refuse rather than pick one.
- **Malformed names are fatal.** A file that does not match `NNNN_name.sql` is
  refused rather than skipped — silently ignoring a migration is how one gets
  left out of production.
- Sorting is numeric, not lexicographic, so the scheme survives passing `0009`.

### 2. Runner — `src/migrations/runner.ts`

`migrateToHead(sql)` and `migrateTo(sql, version)`, both returning what they
applied.

- **One advisory lock for the entire run**, on a fixed key. Two application
  instances booting at once, or two CI jobs against one server, must not both
  apply `0007`. This mirrors `PostgresInventoryLedgerRepository`, which already
  serialises with `pg_advisory_xact_lock`.
- **One transaction per migration**, not one for the whole run. PostgreSQL has
  transactional DDL, so a failing migration rolls back cleanly on its own while
  every migration before it stays applied and recorded. A single wrapping
  transaction would throw away good work because a later file was broken.
- **The tracking row is written in the same transaction as the migration it
  records.** If they were separate, a crash between them would leave a migration
  applied but unrecorded, and the next run would apply it twice.
- Already-applied migrations are skipped, so a re-run is a no-op.

### 3. Tracking table — `schema_migrations`

Created by the runner itself, before anything else, with `CREATE TABLE IF NOT
EXISTS`. It cannot live in a migration file: it is what decides whether
migration files run.

| Column | Purpose |
|---|---|
| `version` | text, primary key |
| `name` | full filename, for a legible audit trail |
| `checksum` | SHA-256 of the file contents as applied |
| `applied_at` | timestamptz, defaults to `now()` |

**The checksum refuses to run when an already-applied file has changed on
disk.** This guard is worth building while every file is still idempotent,
because that is exactly when the habit of "just re-run them" forms. The first
migration containing a data backfill or an unguarded `ALTER` makes a silent
re-run destructive, and by then the guard is retrofitted onto a database that
has already drifted.

Refusing is the whole behaviour: the runner reports which file changed and
stops. It does not attempt to reconcile, because it cannot know whether the
edit was a typo fix or a semantic change.

### 4. CLI — `bin/migrate.mjs`

Reads a connection string from `DATABASE_URL` (or `--database-url`), runs
`migrateToHead`, prints each migration applied or skipped, exits non-zero on
failure. Thin by design: all behaviour lives in the library, so the CLI is not
a second place where migration logic can drift.

## Test conversion

`createDisposableDatabase()` gains a migrated variant so a test asks for a
database at head rather than assembling one. All five integration files drop
their hand-picked lists.

**One deliberate exception.** `database-guarantees.integration.test.ts` has a
test that simulates upgrading an *old* database — it must start below head to
mean anything. It keeps explicit control via `migrateTo`, with a comment saying
why. That is an opt-out with a stated reason, not a leftover subset.

## CI

The workflow gains a PostgreSQL 17 service and a step running the integration
suite. This is the payoff: the branch's strongest invariants — every
reservation, release, and idempotency case in the shared contract suite — stop
being invisible to CI.

The existing unit-test step keeps its `--exclude` so unit and integration
failures stay distinguishable.

## Error handling

Every failure names the file and stops. Specifically:

| Condition | Behaviour |
|---|---|
| Duplicate version | Refuse before applying anything |
| Malformed filename | Refuse before applying anything |
| Checksum mismatch on an applied migration | Refuse before applying anything |
| SQL error inside a migration | That migration's transaction rolls back; earlier ones stay applied and recorded; the run exits non-zero naming the file |
| Requested version does not exist | Refuse, listing known versions |

Validation of the whole set happens *before* any migration is applied, so a
malformed directory never leaves a database half-migrated.

## Testing

**Discovery (unit, temp directory):** correct numeric ordering; a gap is
tolerated; `0010` sorts after `0009`; duplicate versions rejected; malformed
names rejected.

**Runner (integration, disposable database):** fresh database reaches head;
a partially-migrated database applies only what is missing; a re-run applies
nothing; a changed already-applied file is refused; a migration that throws
leaves earlier migrations recorded and itself unrecorded; two concurrent
runners against one database serialise rather than double-apply.

The concurrency case is staged deterministically — one runner parks on the
advisory lock while the other proceeds — following the pattern already proven
in `database-guarantees.integration.test.ts`, not by hoping a race occurs.

## Consequences

- Recorded backlog item 4 closes.
- Integration tests exercise the real schema, and CI runs them.
- Deployment gains its prerequisite, without committing to a host.
- Migration files must stay append-only once applied anywhere — the checksum
  enforces it. This is a new constraint on contributors and belongs in
  `CLAUDE.md`.
