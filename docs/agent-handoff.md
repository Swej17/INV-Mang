# Agent handoff — Simple Flame inventory build

Written for whoever picks this up next: a compacted session, a fresh session, or
Codex. Everything here is verifiable from the repo; nothing depends on
conversation history.

## Where things stand

**Tasks 1–11 of 18 merged**, plus one remediation pass.

| Branch | Commit | Meaning |
|---|---|---|
| `main` | `4573754` | **Untouched.** Only the plans. Do not merge here without the owner's word. |
| `phase1/integration` | `c6f806f` | All merged work lands here, fast-forward only |

```
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

**Test counts at `c6f806f`:** domain 214, contracts 43, application 36, api 19,
worker 12, persistence-postgres integration 25.

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

Every item is recorded rather than silently carried.

1. **`markOrdered` posts `SYNCHRONIZATION_CORRECTION` for a purchase.** That
   cause means "reconciled against the authoritative server", so every purchase
   looks like a sync repair and a genuine repair becomes indistinguishable.
   Needs a `PURCHASE_ORDERED` member in `LEDGER_CAUSES` (the zod enum derives
   from it automatically) plus an `ALTER TABLE ... DROP CONSTRAINT ... ADD
   CONSTRAINT` migration — the CHECK is inline in a `CREATE TABLE IF NOT EXISTS`,
   so re-running `0001` will not update it.
2. **`RecipeComponent.countable` is read nowhere.** Zero non-test reads. Either
   enforce it (ceil required quantities, floor availability, reject a
   non-integer `perUnitBase`) or delete the field — right now it reads as a
   guarantee and is not one.
3. **Migrations 0002/0003/0004 have no repository.** Sixteen tables, no reader or
   writer, so their constraints are exercised only by the migration running.
   `recipe_components` also cannot represent `dependencyClass` or `countable`,
   which both the capacity engine and batch completion filter on.
4. **`production_batch_lots` is weaker than the ledger it traces.** No
   append-only trigger, and `ON DELETE CASCADE` from `production_batches` means
   one delete erases every lot linkage while the consumption entries survive.
   `inventory_lots` is freely mutable too.
5. **`0005_orders_packing.sql` was never written.** Task 8 shipped domain only.
   `0004` is vendors/purchasing (renumbered; the gap is safe because
   orders/packing depends only on `0002`).
6. **Drizzle schema modules** were specified in Tasks 4 and 5 and never written.
   Raw SQL migrations plus `postgres.js` are used instead.
7. **Scaffold portability**: root `typecheck`/`build` call bare `pnpm -r`.
8. **`SKIP LOCKED` is not proven load-bearing** in the job runner — plain
   `FOR UPDATE` also yields one winner. The difference is throughput, and
   proving it needs a contention benchmark. Recorded in the test itself.

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
