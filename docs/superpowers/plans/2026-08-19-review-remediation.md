# Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the High findings and the self-contained Medium/Low findings from the 2026-08-19 full-base review, without touching the deferred items (M2 lot draw-down, M3 projection performance, M6 runnable service) that need owner decisions.

**Architecture:** Five worker tasks, each on its own branch in its own worktree under `../INV-Mang-worktrees/`, merged fast-forward into `phase1/integration` by the manager. Wave 1 = Tasks 1, 3, 4, 5 in parallel (disjoint files). Wave 2 = Task 2, branched only AFTER Task 1 merges (both touch `postgres-inventory-ledger.ts`). Manager handles main-branch hygiene, merges, renormalization, push, and final cold review.

**Tech Stack:** TypeScript (node16 resolution), zod v4, decimal.js, postgres.js, Fastify, vitest, PostgreSQL 17 (native, `postgres:postgres@127.0.0.1:5432`; integration tests use `disposable-postgres.ts`).

**Spec:** `C:\Users\Swej\INV-Mang-worktrees\review-artifacts\2026-08-19-full-base-review.md` (finding IDs H1–H5, M1–M7, L1–L6 refer to that document). Repo conventions: `docs/agent-handoff.md` on `phase1/integration`.

## Global Constraints

- Quantities are canonical decimal **strings**. `assertCanonicalDecimal` for signed deltas, `assertNonNegativeDecimal` for magnitudes. Never JavaScript numbers for quantities.
- TDD: failing test first, then minimal implementation, then mutation-test each new invariant (break it one way, watch a test fail, restore).
- Every worktree starts with `corepack pnpm install --frozen-lockfile`. Always `corepack pnpm`, never bare `pnpm`.
- `corepack pnpm typecheck` is a SEPARATE gate from tests. Run both before every commit, plus `corepack pnpm lint` and `corepack pnpm check:boundaries`.
- Integration tests: `cd packages/persistence-postgres && corepack pnpm vitest run --config vitest.integration.config.ts` (requires local PostgreSQL 17).
- Line endings are a known hazard (no .gitattributes yet): do not let your editor/tool rewrite whole files; keep diffs minimal.
- Branch from `phase1/integration`. One branch per task: `claude/fix-<slug>`. Commit style matches history: `fix: <imperative sentence>` / `feat:` / `chore:` / `docs:`.
- Do NOT run `git add --renormalize`. Do NOT push. Do NOT merge. The manager does those.
- Comments state invariants and rationale, not narration — match the existing house style.

---

### Task 1: Ledger guarantee gaps (H1 org-scoped idempotency, H4 negative reserved/incoming, L5 view caveat)

**Branch:** `claude/fix-ledger-guarantees` · **Wave 1**

**Files:**
- Modify: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.ts`
- Modify: `packages/persistence-contracts/src/inventory-ledger.ts` (new typed errors)
- Modify: `packages/persistence-contracts/src/index.ts` (export them)
- Modify: `packages/persistence-contracts/src/inventory-ledger.contract.ts` (shared contract cases)
- Modify: `packages/persistence-postgres/drizzle/0001_inventory_ledger.sql` (COMMENT ON COLUMN only)
- Test: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.integration.test.ts`

**Interfaces:**
- Produces: `class CommandIdCollisionError extends Error { constructor(readonly commandId: string) }` and `class InvalidLedgerStateError extends Error { constructor(readonly itemId: string, readonly locationId: string, readonly field: "reserved" | "incoming", readonly value: string) }`, both exported from `@simple-flame/persistence-contracts`. Task 2 catches these in the push handler.
- `appendOnce` signature unchanged.

- [ ] **Step 1: Write failing integration tests** (in the postgres integration test file, using the existing fixture helpers already present there):

```ts
test("a command id replayed by a DIFFERENT organization is rejected, not replayed", async () => {
  const commandId = randomUUID();
  await repo.appendOnce(commandId, ORG_A, [receiptEntry("10")]);
  await expect(
    repo.appendOnce(commandId, ORG_B, [receiptEntry("10")]),
  ).rejects.toBeInstanceOf(CommandIdCollisionError);
  // Org B must not have observed org A's entries, and org A's ledger is untouched.
  expect((await repo.listEntries(ORG_B, ITEM)).length).toBe(0);
});

test("a command that would drive reserved negative is refused", async () => {
  await repo.appendOnce(randomUUID(), ORG_A, [receiptEntry("10")]);
  await expect(
    repo.appendOnce(randomUUID(), ORG_A, [reserveEntry("-3")]), // release with nothing reserved
  ).rejects.toBeInstanceOf(InvalidLedgerStateError);
});

test("a command that would drive incoming negative is refused", async () => {
  await expect(
    repo.appendOnce(randomUUID(), ORG_A, [incomingEntry("-5")]),
  ).rejects.toBeInstanceOf(InvalidLedgerStateError);
});
```

- [ ] **Step 2: Run, verify all three FAIL** (cross-org test currently gets a `duplicate: true` replay; negative tests currently succeed).
- [ ] **Step 3: Add the two error classes** to `persistence-contracts/src/inventory-ledger.ts` beside `InsufficientAvailableError` (same shape: readonly fields, `this.name = ...`), export from the package index.
- [ ] **Step 4: Scope the idempotency lookup** in `appendOnce`: `WHERE command_id = ${commandId} AND organization_id = ${organizationId}`. Wrap the `INSERT INTO processed_commands` so a unique violation (postgres.js error with `code === "23505"`) rethrows as `CommandIdCollisionError(commandId)` — a cross-org collision must fail loudly, never leak the other org's result and never silently no-op. Keep the global PK; UUIDs make legitimate collisions impossible, so no FK surgery is needed.
- [ ] **Step 5: Extend `assertResultingStateIsValid`**: after the existing checks add

```ts
if (reserved.isNegative()) {
  throw new InvalidLedgerStateError(itemId, locationId, "reserved", projected.reserved);
}
const incoming = assertCanonicalDecimal(projected.incoming);
if (incoming.isNegative()) {
  throw new InvalidLedgerStateError(itemId, locationId, "incoming", projected.incoming);
}
```

- [ ] **Step 6: Run integration tests, verify PASS. Then mutation-test:** delete the org filter → cross-org test fails; flip `isNegative()` to `isPositive()` on each new check → its test fails; restore.
- [ ] **Step 7: Add the same three cases to the shared contract suite** (`inventory-ledger.contract.ts`) so IndexedDB/SQLite adapters inherit them — follow the existing suite's registration pattern.
- [ ] **Step 8 (L5):** In `0001_inventory_ledger.sql`, after the view, add:

```sql
COMMENT ON COLUMN inventory_projections.available IS
  'on_hand - reserved only. Does NOT subtract protected stock: the domain''s available is max(0, on_hand - reserved - protected). Do not promise from this column.';
```

- [ ] **Step 9: Full gates** (`test`, `typecheck`, `lint`, `check:boundaries`, integration config) then commit: `fix: scope idempotency by organization and refuse negative reserved or incoming`.

---

### Task 2: Make the sync contract true (H2 conflicts, H3 baseRevision, H5 order.release, M7 pull)

**Branch:** `claude/fix-sync-protocol` · **Wave 2 — branch only after Task 1 is merged into `phase1/integration`**

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/routes/translate-command.ts` (remove the `order.release` throw path — the route handles release)
- Modify: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.ts` (new `releaseOrder` method)
- Modify: `packages/persistence-contracts/src/inventory-ledger.ts` (add `releaseOrder` to the interface)
- Modify: `packages/contracts/src/common.ts` (documentation comment on `baseRevision` semantics only)
- Test: `apps/api/src/routes/commands.integration.test.ts`, `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.integration.test.ts`

**Interfaces:**
- Consumes: `CommandIdCollisionError`, `InvalidLedgerStateError` from Task 1.
- Produces: `releaseOrder(commandId: string, organizationId: string, orderId: string, locationId: string, reason: string): Promise<AppendResult>` on `InventoryLedgerRepository`.

**Design decisions (already made — implement, don't re-litigate):**
- `baseRevision` is enforced ONLY for `order.reserve` (its meaning depends on observed availability). `inventory.receive` and `inventory.adjust` are signed deltas and deliberately apply regardless; say so in the `CommandEnvelope` comment.
- On the FIRST conflict the handler stops processing the batch (later queued commands may depend on earlier ones), returns **200** with `accepted` = commands landed so far and `conflicts` = the one conflict. Unprocessed commands are simply not in either list; the client resubmits them.

- [ ] **Step 1: Failing API tests** (extend the existing integration test file, which already builds a server + session):

```ts
test("insufficient availability comes back as a typed conflict, not a 500", async () => {
  // seed 5 on hand, then push [receive 3 (ok), reserve 100 (conflict), receive 1 (must NOT apply)]
  const res = await push([receive3, reserve100, receive1]);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.accepted.map((a) => a.commandId)).toEqual([receive3.commandId]);
  expect(body.conflicts).toHaveLength(1);
  expect(body.conflicts[0].code).toBe("INSUFFICIENT_AVAILABLE");
  expect(body.conflicts[0].localIntent.commandId).toBe(reserve100.commandId);
});

test("a stale reserve is refused with REVISION_CHANGED", async () => {
  // write once to advance revision, then push order.reserve with baseRevision "0"
  const body = (await push([staleReserve])).json();
  expect(body.conflicts[0].code).toBe("REVISION_CHANGED");
});

test("order.release returns exactly the outstanding reservation and is idempotent", async () => {
  await push([receive10, reserve4]);
  await push([release]);           // reserved back to 0
  await push([release]);           // replay: duplicate, no double-release
  const projection = await getProjection();
  expect(projection.reserved).toBe("0");
});
```

- [ ] **Step 2: Run, verify FAIL** (first currently 500s; second currently applies; third currently 422s).
- [ ] **Step 3: Implement `releaseOrder`** in the postgres repository. One transaction: org-scoped idempotency check (replay returns original result, `duplicate: true`); find outstanding =

```sql
SELECT item_id, location_id, SUM(reserved_delta)::text AS net
FROM inventory_ledger_entries
WHERE organization_id = ${organizationId}
  AND location_id = ${locationId}
  AND metadata->>'orderId' = ${orderId}
  AND cause IN ('ORDER_RESERVATION', 'RESERVATION_RELEASE')
GROUP BY item_id, location_id
HAVING SUM(reserved_delta) <> 0
```

then take the sorted advisory locks for those scopes (same helper pattern as `appendOnce`), **re-run the query after locking** (closes the race with a concurrent reserve), post one `RESERVATION_RELEASE` entry per row with `reservedDelta = -net` and `metadata: { orderId, reason }`, through the same record/validate/insert path as `appendOnce`. When nothing is outstanding: mint a revision, record the processed command with `entries: []`, insert no ledger rows (the `moves_something` constraint forbids zero-delta rows, and an empty release is a legitimate no-op, not an error).
- [ ] **Step 4: Rewrite the push handler loop** in `server.ts`:

```ts
for (const command of parsed.data.commands) {
  if (command.organizationId !== session.organizationId) { /* existing 403 */ }

  if (command.type === "order.reserve") {
    // Optimistic-concurrency gate. Advisory: the appendOnce availability check
    // remains the hard guarantee; this catches stale clients before they consume it.
    const staleItem = await firstItemChangedSince(command); // getProjection per line item, compare revision > baseRevision
    if (staleItem) { conflicts.push(revisionChangedConflict(command, staleItem)); break; }
  }

  try {
    const result =
      command.type === "order.release"
        ? await ledger.releaseOrder(command.commandId, session.organizationId,
            command.payload.orderId, command.payload.locationId, command.payload.reason)
        : await ledger.appendOnce(command.commandId, session.organizationId, translateCommand(command));
    accepted.push({ commandId: command.commandId, revision: result.revision, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof InsufficientAvailableError) {
      conflicts.push(insufficientConflict(command, error)); break;
    }
    if (error instanceof CommandIdCollisionError || error instanceof InvalidLedgerStateError) {
      return reply.code(409).send({ error: error.message, commandId: command.commandId });
    }
    throw error;
  }
}
```

with `insufficientConflict` building a `SyncConflictV1`: `serverSnapshot` = the current projection for the failing item, `localIntent` = the command itself, `allowedResolutions: ["KEEP_SERVER", "EDIT_AND_RESUBMIT"]`, human-readable `explanation`. The `translateCommand` 422 path stays as is. Response: `SyncPushResultV1.parse({ version: 1, serverRevision, accepted, conflicts })` — always 200 when the envelope was valid.
- [ ] **Step 5 (M7):** In `/v1/sync/pull`, validate `sinceRevision` (existing) plus optional `limit` (integer 1..1000, default 500, else 422); query `LIMIT ${limit + 1}`; respond `{ version: 1, entries: rows.slice(0, limit), hasMore: rows.length > limit }`. Add a test asserting `hasMore` flips at the boundary.
- [ ] **Step 6:** In `translate-command.ts`, replace the `order.release` throw with a comment stating release is applied by the route via `releaseOrder` (it needs ledger history, which a pure translation cannot read) and `throw new Error("order.release is applied by the route, not translated")` so a future second call site still fails loudly. Update the stale "negative units" comment — the schema forbids that, which was the bug.
- [ ] **Step 7:** Run all tests → PASS. Mutation-test: remove the post-lock re-query → concurrency comment test... (cannot stage the race deterministically; instead delete the `HAVING` clause → idempotent-release test fails; remove the `break` on conflict → ordering test fails; restore.)
- [ ] **Step 8:** Full gates, then commit: `fix: honor the sync conflict contract and apply order releases`.

---

### Task 3: Boundary validation (M1 lot-override draws, M4 NaN instants)

**Branch:** `claude/fix-boundary-validation` · **Wave 1**

**Files:**
- Modify: `packages/application/src/production/complete-batch.ts`
- Create: `packages/domain/src/time/parse-instant.ts` + export from `packages/domain/src/index.ts`
- Modify: `packages/domain/src/orders/evaluate-order.ts`, `packages/domain/src/forecast/calculate-forecast.ts`
- Test: `packages/application/src/production/complete-batch.test.ts`, `packages/domain/src/orders/evaluate-order.test.ts`, `packages/domain/src/forecast/calculate-forecast.test.ts`, `packages/domain/src/time/parse-instant.test.ts`

**Interfaces:**
- Produces: `parseInstant(value: string, label: string): number` — epoch ms, throws `` `${label} is not a valid instant: ${value}` `` when `Date.parse` yields NaN.

- [ ] **Step 1: Failing domain tests:**

```ts
test("an unparseable sync timestamp is an error, never silently fresh", () => {
  expect(() => evaluateOrder({ ...base, lastAuthoritativeSyncAt: "not-a-date" })).toThrow(/instant/);
});
test("a manual event with an unparseable date is an error, never silently dropped", () => {
  expect(() => calculateForecast(history, 30, [{ ...event, occursAt: "garbage" }])).toThrow(/instant/);
});
test("an override with an unparseable expiry is an error, never silently expired", () => {
  expect(() => calculateForecast(history, 30, [], { ...override, expiresAt: "garbage" })).toThrow(/instant/);
});
```

- [ ] **Step 2: Verify FAIL** (today: `stale: false`, event dropped, override deactivated — all silent).
- [ ] **Step 3: Implement `parseInstant`** (6 lines; rationale comment: NaN comparisons all answer false, which made bad data report itself as fresh — the one direction a staleness flag must never fail). Use it in `minutesBetween` (both operands), and in `calculate-forecast.ts` for `history.asOf`, `event.occursAt`, `override.expiresAt`.
- [ ] **Step 4: PASS + mutation-test** (replace a `parseInstant` call with bare `Date.parse` → its test fails; restore).
- [ ] **Step 5: Failing application tests** for overrides:

```ts
test("a negative draw cannot hide inside a correct total", async () => {
  // required 5; draws +7 and -2 total 5 exactly
  await expect(run({ lotOverrides: { [WAX]: [draw(LOT_A, "7"), draw(LOT_B, "-2")] } }))
    .rejects.toThrow(/negative/);
});
test("the same lot cannot be drawn twice in one override", async () => {
  await expect(run({ lotOverrides: { [WAX]: [draw(LOT_A, "3"), draw(LOT_A, "2")] } }))
    .rejects.toThrow(/duplicate/);
});
test("a draw cannot exceed the lot's remaining quantity", async () => {
  // LOT_A has 4 remaining; draw 5 from it
  await expect(run({ lotOverrides: { [WAX]: [draw(LOT_A, "5")] } }))
    .rejects.toThrow(/exceeds/);
});
```

- [ ] **Step 6: Implement in the override branch** of `complete-batch.ts`, BEFORE the total check: validate each draw with `assertNonNegativeDecimal(draw.quantity, ...)` and reject zero; reject duplicate `lotId`s via a `Set`; build `remainingByLot` from the existing `listAvailable` call (extend the `known` Set into a Map) and reject `draw.quantity > remaining` with a message naming the lot, the draw, and the remaining. Keep the existing total and unknown-lot checks.
- [ ] **Step 7: PASS + mutation-test each check.** Fixture rule from the handoff applies: make values disagree on every axis except the one under test (e.g. the duplicate-lot fixture must still total correctly, so the total check cannot be what catches it).
- [ ] **Step 8:** Full gates, commit: `fix: validate lot override draws and refuse unparseable instants`.

---

### Task 4: Worker lease safety (M5)

**Branch:** `claude/fix-worker-lease` · **Wave 1**

**Files:**
- Modify: `apps/worker/src/runner.ts`, `apps/worker/src/index.ts` (export nothing new beyond types if needed)
- Test: `apps/worker/src/runner.integration.test.ts`

**Interfaces:**
- Produces: `renewLease(jobId: string): Promise<boolean>` on `JobRunner` (true when this worker still holds the lease). `runOnce` behavior otherwise unchanged.

- [ ] **Step 1: Failing tests:**

```ts
test("a long job's lease is renewed so reclaimExpired does not steal it", async () => {
  // leaseSeconds: 1, handler resolves after ~2.5s but calls/receives heartbeats
  // assert: during the run, reclaimExpired() returns 0 and the job completes once
});
test("completion is fenced: a worker that lost its lease cannot clobber the retry", async () => {
  // claim with worker A, force-expire the lease, reclaim + claim with worker B,
  // then call A's complete(job.id) — job must still be RUNNING for B, not COMPLETED
});
```

- [ ] **Step 2: Verify FAIL** (`reclaimExpired` currently steals; `complete` currently updates unconditionally).
- [ ] **Step 3: Implement.** `renewLease`: `UPDATE jobs SET leased_until = now() + interval WHERE id = ${jobId} AND leased_by = ${workerId} AND status = 'RUNNING' RETURNING id` → `rows.length > 0`. In `runOnce`, start `setInterval` at `Math.max(1, leaseSeconds / 3) * 1000` ms calling `renewLease`; clear it in `finally`. **Fence the terminal writes:** `complete` and `fail` add `AND leased_by = ${this.options.workerId} AND status = 'RUNNING'` so a worker that lost its lease cannot overwrite another worker's claim (rationale comment: the lease is only a guarantee if every write that assumes it re-checks it).
- [ ] **Step 4: PASS + mutation-test** (drop the `leased_by` fence from `complete` → fencing test fails; restore).
- [ ] **Step 5:** Full gates, commit: `fix: renew job leases during execution and fence terminal writes`.

---

### Task 5: Repo hygiene (L3 .gitattributes, L4 CI + test halt, conventions promotion)

**Branch:** `claude/fix-ci-hygiene` · **Wave 1**

**Files:**
- Create: `.gitattributes`, `.github/workflows/ci.yml`, `CLAUDE.md`
- Modify: `packages/persistence-contracts/package.json`

**Interfaces:** none consumed or produced.

- [ ] **Step 1: `.gitattributes`** (do NOT renormalize — the manager does that after all merges, to avoid poisoning every other branch's diff):

```
* text=auto
*.ts text eol=lf
*.mjs text eol=lf
*.sql text eol=lf
*.md text eol=lf
*.json text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
```

- [ ] **Step 2: Fix the halting package.** Backlog item 5: `packages/persistence-contracts` is types-only and its test script exits 1 with "No test files found", halting `pnpm -r test`. Set its `"test": "vitest run --passWithNoTests"`. Verify from the repo root that `corepack pnpm -r --if-present test` now runs every package (this is the fix's acceptance test — run it and read the tail).
- [ ] **Step 3: `.github/workflows/ci.yml`** — on push/PR to `phase1/integration` and `main`: checkout, `corepack enable`, Node 24 via actions/setup-node, `corepack pnpm install --frozen-lockfile`, then `lint`, `typecheck`, `check:boundaries`, `test`. Unit tests only — integration tests need the migration runner (recorded backlog item 4) before they can run in CI; say so in a comment in the workflow.
- [ ] **Step 4: `CLAUDE.md`** at repo root. Content: extract verbatim-in-spirit from `docs/agent-handoff.md` — the conventions section (canonical decimal strings, quantise-at-boundary, org-scoped reads, review artifacts outside worktrees), the fixture discipline ("make the values disagree on every axis except the one under test", with the confirmed failure examples), and the environment landmines (corepack pnpm, typecheck as separate gate, native PostgreSQL 17, Podman-only + WSL2 port-forwarding limitation, worktree workflow). Keep it under ~80 lines; link to the handoff doc for history. Note inside it that `main` holds docs only and code lives on `phase1/integration`.
- [ ] **Step 5:** `corepack pnpm lint` still passes (new files excluded or clean); commit: `chore: add CI, line-ending policy, and standing agent conventions`.

---

### Manager runbook (not delegated)

- [ ] **M-1 (L2, main working tree):** From Git Bash: `rm NUL` in `C:\Users\Swej\Simple Flame IV MANG`; append `NUL` to `.gitignore`; add a line to `README.md`: code lives on `phase1/integration`, `main` is docs-only. Commit to `main` as `docs: point at the integration branch and ignore Windows NUL artifacts` (docs-only commits to main are the established pattern; no merge involved).
- [ ] **M-2:** Commit this plan to `main` (`docs:` prefix).
- [ ] **M-3:** Dispatch wave 1 (Tasks 1, 3, 4, 5) as parallel background agents. Task 1 → Opus (correctness-critical persistence). Tasks 3, 4, 5 → Sonnet (well-scoped).
- [ ] **M-4:** As each wave-1 branch lands: review the diff, run the full gate suite in a clean reviewer worktree, then merge fast-forward (or `--no-ff` only if FF impossible) into `phase1/integration` in order 1 → 3 → 4 → 5.
- [ ] **M-5:** Dispatch Task 2 → Opus, branching from the updated `phase1/integration`. Review + merge as above.
- [ ] **M-6:** On `phase1/integration` after all merges: `git add --renormalize .` and commit `chore: normalize line endings under the new attributes policy` (single commit, after merges, so no other branch conflicts with it).
- [ ] **M-7 (L1):** `git push -u origin phase1/integration main` plus the five remediation branches. (Authorized by the owner's instruction to complete this plan; pushing to their own private repo, no merge to main.)
- [ ] **M-8:** Dispatch a cold review (Opus, fresh eyes, read-only) of `git diff cc1525f..phase1/integration` against the review doc's findings, per the repo's review protocol. Fix or record anything it raises; update `docs/agent-handoff.md` backlog (items closed: H1, H2, H3, H4, H5, M1, M4, M5, M7, L2, L3, L4, L5; still open: M2, M3, M6 + prior backlog).
- [ ] **M-9:** Report to owner with commit list, test counts, and what remains deferred.

## Deliberately deferred (need owner decisions — do not implement)

- **M2** (lot draw-down writers) — belongs with the 0002–0004 repository work (backlog 1).
- **M3** (O(n²) append validation) — premature at current volume; revisit with real data.
- **M6** (entrypoints, login, deployment) — blocked on choosing a host and an identity provider.
- **L6** (rate limiting/logging) — meaningful only once M6 makes the service internet-facing.
