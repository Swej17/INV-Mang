# Agent handoff — Simple Flame inventory build

Written for whoever picks this up next: a compacted session, a fresh session, or
Codex. Everything here is verifiable from the repo; nothing depends on
conversation history.

## Where things stand

**Tasks 1–11 of 18 merged**, plus one remediation pass.

| Branch | Commit | Meaning |
|---|---|---|
| `main` | `4573754` | **Untouched.** Only the plans. Do not merge here without the owner's word. |
| `phase1/integration` | `23b7b42` | All merged work lands here, fast-forward only |

```
23b7b42  fix: close three recorded ledger and traceability defects (backlog 1, 2, 4)
c6f806f  fix: scope the ledger by organization and assess every order line
eae2f53  feat: add authenticated command API and worker jobs          (Task 11)
c258ea8  feat: add explainable inventory demand forecasts             (Task 10)
4468cd9  feat: recommend and receive vendor purchases                 (Task 9)
f48233b  fix: refuse invalid magnitudes and prove the database guarantees
3e2c48e  feat: evaluate order production and shipping readiness       (Task 8)
2aafa4c  feat: record traceable candle production batches             (Task 7)
c35847b  feat: allocate shared materials across production plans      (Task 6)
fd16c03  feat: calculate candle capacity from versioned recipes       (Task 5)
9d0657d  test: verify the ledger against real PostgreSQL              (Task 4)
362e4e5  feat: add immutable inventory ledger with PostgreSQL adapter (Task 4)
16647ff  feat: define inventory command and sync contracts            (Task 3)
9791578  fix: reject non-canonical quantity strings                   (Task 2)
3b16a7b  feat: add exact inventory unit conversions                   (Task 2)
c6acd5a  chore: initialize Simple Flame inventory monorepo            (Task 1, by Codex)
```

**Test counts at `23b7b42`:** domain 222, contracts 43, application 41, api 19,
worker 12, persistence-postgres integration 42.

## How to run anything

```bash
corepack pnpm install --frozen-lockfile     # required in EVERY new worktree
corepack pnpm --filter @simple-flame/domain test
corepack pnpm typecheck                     # a SEPARATE gate; see below
corepack pnpm lint
corepack pnpm check:boundaries
cd packages/persistence-postgres && corepack pnpm vitest run --config vitest.integration.config.ts
```

`corepack pnpm`, not bare `pnpm` — the root scripts call bare `pnpm -r`
internally, which fails on a machine without a pnpm shim. Tracked as an open
scaffold-portability item.

**Typecheck is not implied by tests.** It caught a `node16` module-resolution bug
that 23 passing tests missed. Run it before every commit — I once committed with
`typecheck=2` and only caught it because I read the exit code.

## Environment

- **PostgreSQL 17 runs natively.** `PGPASSWORD=postgres`, user `postgres`,
  `127.0.0.1:5432`. Integration tests create and drop a throwaway database per
  run (`packages/persistence-postgres/src/testing/disposable-postgres.ts`).
- **Docker is prohibited** on this project. Podman is the only approved engine.
- **Podman cannot forward container ports on this host.** The WSL2 kernel has no
  `nf_tables`, so netavark cannot install forwarding rules, and setting
  `firewall_driver="none"` removes forwarding entirely. Containers run; the host
  cannot reach a mapped port. This is why the test fixture uses native
  PostgreSQL, and it still blocks Task 18's container verification.
- `podman compose` shells out to `docker-compose.exe`, which violates the
  Podman-only directive. Task 18 needs `podman-compose` or `podman kube play`.

## Working method

Per-task worktrees under `../INV-Mang-worktrees/`, one branch per task, merged
fast-forward into `phase1/integration`. Reviewers get their **own** worktree —
sharing one with active work produced a garbage test count once.

Each task: failing test first, implement, then **mutation-test every invariant**
before committing. Break one thing at a time, re-run, restore. A mutation that
breaks nothing is a finding, not a pass.

**Back up untracked files with `cp` before mutating them.** `git checkout` cannot
restore a file git has never seen; mutations accumulated and corrupted
`apps/api/src/plugins/auth.ts` before I noticed.

## The failure mode that keeps recurring

Not wrong implementations — **fixtures that make a mutation indistinguishable**,
and **assertions on a reported field rather than the arithmetic that consumes it**.
Confirmed instances:

- Two vendors at the same price, so the tie-breaker gave the same answer whether
  or not vendor preference was honoured.
- Two lots where received-date order and lot-id order agreed, so the best-by
  comparison could be deleted.
- Pack size 12, reorder multiple 12, minimum 24, need 13 — all three rules
  coincidentally yield 24, so two rounding mutations survived.
- `lossEnabled: true` on every request while every component used `loss: NONE`.
- A seasonal-factor test asserting `manualDemandUnits` (untouched by the
  mutation) but never the total.
- Countable-item stock fixed at a whole number, so rounding it down changed
  nothing — the rule only becomes visible against fractional stock, and only in
  the reported shortfall rather than in the unit count.
- The API push handler passing an **empty entry list** — 14 tests green while
  nothing was ever written to the ledger.

**When writing a fixture, make the values disagree on every axis except the one
under test.** Two independent cold reviews (92 and 61 mutations) each found
severity-1 defects my own 4–8 mutation passes missed; running one every few
tasks is worth it.

## Next task

**Task 12 — Square catalog, orders, OAuth, webhooks (read mode).** The second
largest remaining. Needs: server-side OAuth code flow with encrypted token
storage, raw-body HMAC signature verification before any persistence, an
idempotent webhook inbox, and scheduled reconciliation for suppressed events.
Read scopes only (`MERCHANT_PROFILE_READ`, `ITEMS_READ`, `INVENTORY_READ`,
`ORDERS_READ`) — writes are Task 17 and are owner-approved by default.

Then 13 (offline outbox), 14 (the whole PWA UI), 15 (Sheets), 16 (alerts),
17 (guarded writeback), 18 (release gate).

## Open backlog

Every item is recorded rather than silently carried. Items 1, 2 and 4 of the
original list were closed in `23b7b42`; the rest keep their meaning, renumbered.

1. **Migrations 0002/0003/0004 still have no repository.** Sixteen tables with
   no reader or writer. `production_batch_lots` and `inventory_lots` now at
   least have integration coverage via their protection triggers, but nothing
   in the application writes them. `recipe_components` also cannot represent
   `dependencyClass` or `countable` — and `countable` is now load-bearing on
   both consumption and shortfall reporting, so a recipe loaded from this table
   would silently lose a rule the domain enforces.
2. **`0005_orders_packing.sql` was never written.** Task 8 shipped domain only.
   `0004` is vendors/purchasing (renumbered; the gap is safe because
   orders/packing depends only on `0002`).
3. **Drizzle schema modules** were specified in Tasks 4 and 5 and never written.
   Raw SQL migrations plus `postgres.js` are used instead.
4. **There is no migration runner.** Migrations are applied only by hand, inside
   individual test files, each listing the subset it happens to need. Nothing
   records which migrations a database has had applied. This was tolerable while
   every migration was a `CREATE TABLE IF NOT EXISTS`; with `0007` and `0008` it
   is not, because both are `ALTER`s that must run once, in order, against an
   already-migrated database. Needed before anything deploys.
5. **Scaffold portability**: root `typecheck`/`build` call bare `pnpm -r`, which
   fails on a machine without a pnpm shim — use `corepack pnpm` instead. (The
   other half of this item — `packages/persistence-contracts`'s `vitest run`
   exiting 1 with "No test files found" and halting `pnpm -r test` — was fixed
   by adding `--passWithNoTests` to its `test` script; no longer true.)
6. **`SKIP LOCKED` is not proven load-bearing** in the job runner — plain
   `FOR UPDATE` also yields one winner. The difference is throughput, and
   proving it needs a contention benchmark. Recorded in the test itself.
7. **`IF EXISTS` on 0007's constraint drop never fires.** Mutation-tested and it
   survives: the constraint always exists when 0007 runs. Kept as protection for
   a database where an operator dropped it by hand, which no test can stage.
   Recorded in the test rather than left to look like coverage.

## Findings closed since the last handoff update

An independent full-base review, `review-artifacts/2026-08-19-full-base-review.md`
(read-only, reviewed at `phase1/integration` @ `cc1525f`), found findings beyond
what this handoff already tracked. All of the following are now closed:

- **H1** — cross-tenant idempotency lookup not scoped by organization, letting
  one org's replayed `commandId` return another org's stored result. Closed in
  `d366c2a`.
- **H2** — a mid-batch failure 500'd after earlier commands had already
  committed, and the typed conflict protocol (`SyncConflictV1`) was defined but
  never used. Closed in `a52153c`.
- **H3** — `baseRevision` was transported but never checked, so reservations
  silently degraded to last-write-wins. Closed in `a52153c` (`order.reserve` is
  gated; signed deltas apply regardless of `baseRevision`, by design — see the
  `CommandEnvelope` comment).
- **H4** — ledger validation never checked `reserved ≥ 0` or `incoming ≥ 0`.
  Closed in `d366c2a`.
- **H5** — `order.release` threw "not yet applied", and its own comment
  described a workaround the schema made impossible. Closed in `a52153c`
  (`releaseOrder` derives the reversal from the order's own reservation
  history).
- **M1** — lot override draws were validated only in total, not per draw
  (negative draws, over-limit draws, and duplicate lot ids all passed). Closed
  in `5cbe69f`.
- **M4** — an unparseable instant made `minutesBetween` NaN, and `NaN >
  threshold` is false, so bad data reported itself as fresh. Closed in
  `5cbe69f` (a `parseInstant` helper that throws instead of reinterpreting).
- **M5** — worker leases were never renewed mid-job, so a handler that outlived
  one lease period got reclaimed and re-run concurrently. Closed in `765b2bc`
  (heartbeat renewal; see also this update's clamp fix below).
- **M7** — `/v1/sync/pull` ignored its own contract (hardcoded limit, no
  `hasMore`). `limit` and `hasMore` are done, closed in `a52153c`. **Still
  open:** the query is parsed by hand (a regex for `sinceRevision`, `limit`
  read via `SyncPullRequestV1.shape.limit` alone) rather than through one
  schema — not counted closed until that's fixed too.
- **L3** — no `.gitattributes`, mixed LF/CRLF with no normalization policy.
  Closed in `aab028c`.
- **L4** — no CI. Closed in `aab028c` (`.github/workflows/ci.yml`).
- **L5** — `inventory_projections.available` ignores protected stock with no
  warning to a caller reading the view directly. Closed in `d366c2a` (a
  `COMMENT ON COLUMN` stating the view's figure is not the domain's `available`).

## Newly parked behaviours

Each of these exists only as a code comment today. Recorded here so the next
reader does not have to rediscover them from source.

1. **`releaseOrder` release-window scope drop**
   (`packages/persistence-postgres/src/repositories/postgres-inventory-ledger.ts`,
   `releaseInTransaction`). A reserve that adds a NEW item/location scope to the
   order between the outstanding-read and lock acquisition is dropped from that
   release — the client is told the release succeeded, but that scope's
   reservation is untouched. Accepted: looping until the read is stable would
   acquire advisory locks out of sorted order, reintroducing the deadlock risk
   the sorted-lock design exists to prevent. A later release under a fresh
   command id picks up what was missed.
2. **Over-released neighbour**
   (`postgres-inventory-ledger.ts`, `outstandingReservations`). An order that
   has been released past its true outstanding total (a negative per-order net)
   can make a DIFFERENT order's legitimate release fail with
   `InvalidLedgerStateError`, because validation guards the item's total
   reserved, not any single order's net. **Not reachable through the sync API
   today** — no route posts a negative `reservedDelta` carrying `orderId`
   metadata; `order.release` always derives its delta from stored history.
   Reaching it needs a direct repository call.
3. **Advisory revision-gate bypass**
   (`apps/api/src/server.ts`, `firstItemChangedSince`). A same-org client can
   exempt an item from the staleness gate by submitting a foreign `commandId`
   as a replay ahead of a reserve, since `appendOnce`'s duplicate check is keyed
   on `commandId` + `organizationId` only, not payload equivalence. Accepted:
   the gate is advisory — `appendOnce`'s availability check is the hard
   guarantee — and closing it would make legitimate partial-batch retries fail
   with `REVISION_CHANGED`.
4. **No clock seam in the ledger repository** — `releaseOrder` mints
   `occurredAt` itself (`new Date().toISOString()`), with no injection point
   for tests. `ServerDeps.now` looked like that seam but was never read
   anywhere; it has been removed rather than wired up, so as not to advertise a
   determinism seam that doesn't exist.

## Found during the remediation, not fixed by it

Two defects surfaced while closing the review's findings. Neither belongs to a
finding this branch set out to close, so both were recorded rather than folded
into an unrelated commit.

1. **`/v1/sync/pull` violates its own contract.** The handler selects raw
   snake_case columns (`id, item_id, location_id, cause, …`) and returns them
   verbatim. `InventoryEventV1` requires camelCase plus `commandId`,
   `organizationId`, `metadata` and `compensatesEventId` — none of which the
   SELECT retrieves. A client parsing the pull response against the published
   contract fails today. Pre-existing; the remediation only touched the query
   parsing on that route, never the SELECT or the response mapping. Fixing it
   means widening the SELECT and mapping the rows, and it should land with a
   `SyncPullResultV1` response schema so the two cannot drift again.
2. **A mid-batch uncaught exception leaves no audit trail.** Every *handled*
   push exit (200, 403, 409, 422) now records what landed and why it stopped.
   The `throw error` fallthrough for unrecognised error types does not, so a
   500 after partial commits is invisible in `audit_events` — the same gap the
   remediation closed for the four handled codes, surviving on the one path it
   did not name.

## CI does not run this branch's strongest new invariants

The 18 shared-contract cases in
`packages/persistence-contracts/src/inventory-ledger.contract.ts` — including
every reservation, release, and idempotency case above — run only via
`postgres-inventory-ledger.integration.test.ts`, which needs real PostgreSQL.
CI's `Test` step excludes `**/*.integration.test.ts` (see the comment in
`.github/workflows/ci.yml`), so none of them execute there. They stay
CI-invisible until backlog item 4 (the migration runner) lands and integration
tests can run in CI.

## Conventions worth keeping

- Quantities are canonical decimal **strings**, never JavaScript numbers.
  `assertCanonicalDecimal` for signed deltas, `assertNonNegativeDecimal` for
  magnitudes. Negative magnitudes previously made protection *increase* capacity
  and let the planner conjure 445 kg of wax.
- Storage is `numeric(24,8)`; the adapter quantises explicitly at the boundary.
  Quantising each delta then summing is **not** the same as quantising the sum —
  tests state the resulting arithmetic rather than assuming `oz("343")`.
- Ledger reads are scoped by `organizationId`. Without it one tenant consumed
  another's stock and reached −400 on hand.
- Review artifacts go **outside** every worktree, in
  `../INV-Mang-worktrees/review-artifacts/`, so no `git status` is polluted.
