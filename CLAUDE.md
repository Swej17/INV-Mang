# Simple Flame inventory — standing conventions

Full history, task log, and open backlog: [`docs/agent-handoff.md`](docs/agent-handoff.md).
This file is the short version agents load automatically; read the handoff doc
for context on *why*.

**`main` holds docs only. Code lives on `phase1/integration`.** Do not merge
feature work into `main` without the owner's word.

## Environment

- **`corepack pnpm`, never bare `pnpm`.** Root scripts call `pnpm -r`
  internally, which fails without a pnpm shim.
- `corepack pnpm install --frozen-lockfile` is required in every new worktree.
- **Typecheck is a separate gate, not implied by tests.** Run
  `corepack pnpm typecheck` before every commit — it has caught bugs that a
  full green test suite missed.
- **PostgreSQL 17 runs natively** at `127.0.0.1:5432`, user `postgres`,
  `PGPASSWORD=postgres`. Integration tests create and drop a throwaway
  database per run.
- **Docker is prohibited. Podman is the only approved engine.** Podman cannot
  forward container ports on this host (WSL2 has no `nf_tables`), which is why
  tests use native PostgreSQL instead of a container. `podman compose` shells
  out to `docker-compose.exe` — don't use it; `podman-compose` or
  `podman kube play` only.
- Worktree workflow: one branch per task under `../INV-Mang-worktrees/`,
  merged fast-forward into `phase1/integration`. Give reviewers their own
  worktree — sharing one with active work has corrupted a test run before.
- Review artifacts go **outside** every worktree, in
  `../INV-Mang-worktrees/review-artifacts/`, so `git status` stays clean.

## Conventions

- Quantities are canonical decimal **strings**, never JavaScript numbers.
  Use `assertCanonicalDecimal` for signed deltas, `assertNonNegativeDecimal`
  for magnitudes — a negative magnitude once made protection *increase*
  capacity.
- Storage is `numeric(24,8)`; adapters quantise explicitly at the boundary.
  Quantising each delta then summing is **not** the same as quantising the
  sum — state the resulting arithmetic in tests rather than assuming a
  shortcut value.
- Ledger reads are scoped by `organizationId`. Without it, one tenant has
  consumed another's stock and reached negative on-hand.

## Fixture discipline

When writing a fixture, **make the values disagree on every axis except the
one under test**, and assert on the arithmetic that consumes a field, not
just the field being echoed back. Confirmed failures from skipping this:

- Two vendors at the same price hid a broken tie-breaker.
- Two lots with received-date and lot-id order in agreement hid a deleted
  best-by comparison.
- Pack size 12 / reorder multiple 12 / minimum 24 / need 13 all coincidentally
  round to 24, hiding two rounding mutations.
- `lossEnabled: true` everywhere while every component used `loss: NONE`.
- A seasonal-factor test asserting the untouched field instead of the total.
- A whole-number stock fixture hid a fractional rounding-down rule.
- An API handler pushing an **empty entry list** — 14 tests green while
  nothing was ever written to the ledger.

Two independent cold reviews (92 and 61 mutations) each found severity-1
defects that 4–8 mutation passes missed; run one every few tasks.
