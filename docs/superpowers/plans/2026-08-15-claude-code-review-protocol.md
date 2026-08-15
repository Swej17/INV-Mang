# Claude Code Implementation and Codex Review Protocol

## Purpose

Claude Code may implement the two plans, but it must not self-declare a task complete and immediately continue. Each implementation task ends at a review gate. Codex will review the actual diff, tests, migrations, and command output against the design and the specific task before Claude proceeds.

## Required execution order

1. Attach the planning workspace to `https://github.com/Swej17/INV-Mang.git`, start from remote `main`, and create `feat/inventory-foundation` as specified in Phase 1 Task 1 Step 0.
2. Execute Phase 1 Tasks 1–18 in order.
3. Stop after each task's tests and commit candidate.
4. Request Codex review using the task number, commit/diff, test output, and any deliberate deviation.
5. Resolve findings through the same implementer context.
6. Rerun the task's focused tests and the regression subset named by the reviewer.
7. Obtain a clean Codex re-review before committing/advancing.
8. Complete the Phase 1 release gate and live acceptance before beginning Phase 2.
9. Execute Phase 2 Tasks 1–8 with the same review loop.

## Review packet Claude must provide

For every task, Claude provides:

- Plan filename and exact task number.
- One-paragraph description of behavior delivered.
- `git status --short`.
- `git diff --stat` and the complete task diff or commit SHA.
- Focused test command and unedited result.
- Typecheck/lint/boundary results required by the task.
- Database migration SQL and rollback/forward strategy when applicable.
- New environment variables, permissions, OAuth scopes, or external write capabilities.
- Any plan deviation, with reason and consequence.
- Known failing tests; zero known failures is expected before review.

Claude must not use screenshots or a visually working UI as proof of inventory correctness.

## Severity model

- **S1 — Stop-ship:** data loss/corruption, double allocation, credential exposure, webhook bypass, unauthorized external write, irreversible migration, duplicated ledger event, unreviewed automatic Square change, or offline command loss.
- **S2 — Must fix before task approval:** incorrect requirement, missing invariant, stale-data misrepresentation, incomplete idempotency, weak conflict handling, wrong unit conversion, non-atomic multi-write flow, inaccessible critical workflow, or desktop boundary violation.
- **S3 — Fix before phase release:** maintainability, test-quality, error-copy, observability, performance, noncritical accessibility, or operational-documentation defect.
- **S4 — Optional improvement:** polish or future enhancement outside the committed acceptance criteria.

Any S1 or S2 keeps the task open. S3 findings are recorded and must be cleared before the phase release gate. S4 does not expand scope unless the owner approves it.

## Codex review checklist

### Requirements and scope

- Does the diff implement only the named task?
- Does behavior match the design document and both phase plans?
- Did Claude invent a shortcut that harms desktop reuse, offline behavior, or auditability?
- Are configurable business inputs kept out of code constants where appropriate?

### Inventory correctness

- Are mass, conversion, and money calculations decimal-safe?
- Does ledger history remain append-only with compensating corrections?
- Can the same command or webhook be delivered twice without double posting?
- Can concurrent orders or production plans allocate the same inventory twice?
- Do protected stock and process-loss toggles only reduce adjusted capacity?
- Are theoretical and adjusted capacity clearly separated?
- Are fulfillment/advisory items prevented from reducing candle-making capacity?
- Does finished stock cover orders before new production is requested?
- Are incoming purchases excluded from current availability?
- Are recipe and lot versions retained for historical batches?

### Offline and synchronization safety

- Does every command carry idempotency, device, revision, and timestamps?
- Can the outbox survive browser/app restart?
- Is accepted-server/local-unacknowledged replay safe?
- Are conflicts explicit and non-destructive?
- Is no local intent silently discarded or converted to last-write-wins?
- Does the UI always show authoritative sync age and queued command count?
- Are PWA and SQLite adapters held to the same contract tests?

### Square safety

- Are OAuth tokens server-only and encrypted?
- Are only necessary scopes requested?
- Is every webhook signature verified against the raw body and exact URL before persistence?
- Are event IDs idempotent and webhook processing asynchronous?
- Does reconciliation recover missed/out-of-order events?
- Is availability writeback manual by default?
- Does automatic mode require explicit opt-in, fresh data, and a second calculation?
- Are all external writes audited with before/after state and result?

### Google Sheets safety

- Is the workbook labeled as a snapshot with timestamp and snapshot ID?
- Are writes batched/retried safely?
- Is `Approved Adjustments` the only import surface?
- Does import preview post nothing?
- Are row IDs idempotent and invalid/stale rows blocked?
- Does confirmation create normal ledger commands rather than mutate projections?
- Is customer PII excluded by default?

### Security and privacy

- Are secrets absent from client bundles, SQLite, IndexedDB, logs, and fixtures?
- Are auth cookies, CSRF, rate limits, role checks, and session revocation correct?
- Are logs structured and redacted?
- Are Tauri capabilities least-privilege?
- Are deep links schema/state/PKCE/expiry/replay validated?
- Are backup encryption and update signatures verified with established libraries?

### Database and migration safety

- Are constraints encoded in the database when possible?
- Does each migration run on empty and representative existing data?
- Are migration operations transactional or protected by a documented two-step deployment?
- Are numeric quantities stored with sufficient exactness?
- Does failure roll back without partial ledger/projection changes?
- Has the restore rehearsal been updated for new persisted data?

### Test quality

- Was the failing test meaningful, or written to mirror implementation?
- Are boundary cases, retries, duplicates, out-of-order events, and concurrency covered?
- Do property tests assert invariants rather than only examples?
- Do integration tests exercise real PostgreSQL/SQLite/Square Sandbox/Sheets behavior where required?
- Are time, UUIDs, networking, and external providers deterministic in unit tests?
- Were assertions weakened or snapshots blindly updated to make tests pass?

### UI and accessibility

- Is domain math absent from React components?
- Are blocker explanations actionable and accurate?
- Are hypothetical and allocated capacity labeled distinctly?
- Are status labels understandable without color?
- Are keyboard navigation, focus, screen-reader names, and WCAG contrast verified?
- Does offline/stale state remain visible on every operational route?

### Phase 2 parity

- Did desktop code reuse shared packages rather than copy them?
- Are platform differences isolated behind capability interfaces?
- Does SQLite store decimal values as text and migrate transactionally?
- Does forced termination preserve outbox commands?
- Are signing, notarization, updater, backup, and recovery procedures tested?
- Do golden PWA and desktop outputs match exactly?

## Anti-rush rules

Claude must stop and request review when any of these occurs:

- A task changes more than its named interfaces and files without a justified plan update.
- A new dependency introduces external state, automatic writes, authentication, cryptography, or persistence.
- A migration cannot be reversed or forward-fixed safely.
- An offline conflict is resolved by overwriting either side.
- A test passes only after weakening an invariant or removing an assertion.
- Square/Google behavior differs from the official API documentation.
- Desktop work requires modifying domain behavior rather than an adapter/capability.

Claude must not defer these conditions as cleanup:

- Idempotency.
- Decimal correctness.
- Database constraints.
- Webhook verification.
- Offline timestamp/staleness display.
- Conflict preservation.
- Role/authorization checks.
- Audit logging for external writes.
- Migration and restore testing.

## Reviewer response format

Codex will return:

1. **Gate result:** approved, approved with S3 follow-ups, or changes required.
2. **Findings:** ordered S1 through S4, each with file/line, evidence, impact, and exact acceptance condition.
3. **Missing verification:** commands or scenarios not demonstrated.
4. **Regression scope:** exact tests Claude must rerun.
5. **Next permitted action:** fix findings, commit current task, or begin the next named task.

No findings means Codex explicitly states that no actionable issue was found; silence is not approval.

## Phase release reviews

Phase 1 receives a full-branch review after Task 18 even if every task was individually approved. It checks cross-task interactions, deployment configuration, OAuth scopes, database restoration, offline conflicts, and end-to-end acceptance.

Phase 2 receives a full-branch review after Task 8. It checks PWA parity, native capability scope, forced-restart durability, secure local secrets, backup recovery, signed updates, notarization, and real-Mac owner acceptance.

Only the owner decides when to ship after Codex reports a clean phase gate.
