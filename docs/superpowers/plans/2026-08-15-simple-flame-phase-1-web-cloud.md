# Simple Flame Phase 1 Web and Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-ready, installable, offline-capable inventory and candle-production web app with Square, Google Sheets, purchasing, forecasting, and email integrations.

**Architecture:** A pnpm TypeScript monorepo separates pure domain logic, versioned contracts, application use cases, persistence ports, shared UI, web PWA, Fastify API, and worker. PostgreSQL is authoritative; the PWA keeps an IndexedDB projection and idempotent command outbox. Every shared package is browser/native neutral so Phase 2 can add Tauri and SQLite without rewriting behavior.

**Tech Stack:** Node.js 24 LTS, pnpm 10, TypeScript 5.9+, React 19, Vite 7, Fastify 5, Supabase-managed PostgreSQL 17+ and Supabase Auth, Drizzle ORM, Zod, decimal.js, Dexie, Workbox, Vitest, Testing Library, Playwright, Docker.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-simple-flame-inventory-design.md` exactly.
- Preserve the current candle recipe: 15.7 oz wax, 1.3 oz fragrance, one vessel, lid, circular label, rectangular scent label, and wooden wick.
- PostgreSQL is authoritative; clients submit immutable commands, never silent absolute-quantity overwrites.
- Use decimal strings and `decimal.js` for mass, conversion, and money; never JavaScript floating-point inventory math.
- Only production-critical items affect candle-making capacity.
- Square availability writeback is disabled and approval-required by default.
- Google Sheets is a labeled mirror plus validated adjustment import, never a live second database.
- Every offline calculation displays the last authoritative sync timestamp.
- Keep `packages/domain`, `packages/contracts`, `packages/application`, `packages/sync`, `packages/persistence-contracts`, `packages/ui`, and `packages/test-kit` free of Tauri imports.
- Use UUIDv7 identifiers and UTC timestamps; display dates in `America/New_York` unless the organization setting changes.
- Every task begins with a failing test, ends with focused and regression tests, and receives a fresh reviewer gate before its commit is accepted.

---

## Planned file structure

- `apps/web/`: PWA entry, IndexedDB adapter, service worker, routes, and browser end-to-end hooks.
- `apps/api/`: Fastify server, auth/session, command API, OAuth callbacks, Square/Google webhooks, health endpoints.
- `apps/worker/`: PostgreSQL-leased jobs for reconciliation, Sheets, forecasts, alerts, digests, and token refresh.
- `apps/desktop/`: reserved Phase 2 package containing only a README and build boundary check in Phase 1.
- `packages/domain/`: dependency-free business calculations and domain types.
- `packages/contracts/`: Zod schemas for API commands, events, integrations, and sync payloads.
- `packages/application/`: use cases and ports coordinating domain and persistence.
- `packages/persistence-contracts/`: repository interfaces and adapter contract tests.
- `packages/persistence-postgres/`: Drizzle schema, migrations, repositories, and transaction adapter.
- `packages/persistence-indexeddb/`: Dexie cache/outbox implementation.
- `packages/sync/`: synchronization state machine and conflict semantics.
- `packages/ui/`: brand tokens, accessible components, feature views, and view models.
- `packages/test-kit/`: fixtures, builders, fake clocks, fake gateways, and golden scenarios.
- `docs/operations/`: setup, backup/restore, integrations, incident response, and launch checklist.

### Task 1: Initialize the monorepo and enforce architecture boundaries

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `scripts/check-boundaries.mjs`
- Create: `apps/desktop/README.md`
- Create: package manifests and `src/index.ts` for every package listed above
- Test: `scripts/check-boundaries.test.mjs`

**Interfaces:**
- Produces workspace packages named `@simple-flame/domain`, `contracts`, `application`, `sync`, `persistence-contracts`, `persistence-postgres`, `persistence-indexeddb`, `ui`, and `test-kit`.
- Produces root commands `lint`, `typecheck`, `test`, `test:e2e`, `check:boundaries`, and `build`.

- [ ] **Step 0: Attach the existing GitHub repository and create the implementation branch**

The current planning workspace is not a Git checkout. The remote repository already has `main` with initial commit `19eb66d` and a README. Preserve the untracked `docs/` planning files while attaching that history:

```bash
git init
git remote add origin https://github.com/Swej17/INV-Mang.git
git fetch origin main
git checkout -B main origin/main
git checkout -b feat/inventory-foundation
```

Run: `git status --short --branch && git remote -v`
Expected: branch `feat/inventory-foundation`, `origin` pointing to `Swej17/INV-Mang`, and the planning documents shown as untracked until Task 1's commit.

- [ ] **Step 1: Write the failing boundary test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBoundaryViolations } from "./check-boundaries.mjs";

test("shared packages cannot import platform adapters", async () => {
  const violations = await findBoundaryViolations(process.cwd());
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: Run the test and confirm it fails because the checker does not exist**

Run: `node --test scripts/check-boundaries.test.mjs`
Expected: FAIL with module-not-found for `check-boundaries.mjs`.

- [ ] **Step 3: Create workspace configuration and the boundary checker**

```js
// scripts/check-boundaries.mjs
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const shared = ["domain", "contracts", "application", "sync", "persistence-contracts", "ui", "test-kit"];
const forbidden = ["@tauri-apps/", "apps/web", "apps/api", "apps/worker", "persistence-indexeddb", "persistence-postgres"];

export async function findBoundaryViolations(root) {
  const hits = [];
  for (const pkg of shared) {
    const dir = path.join(root, "packages", pkg, "src");
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const source = await readFile(file, "utf8");
      for (const token of forbidden) if (source.includes(token)) hits.push({ file, token });
    }
  }
  return hits;
}
```

Set `engines.node` to `>=24 <25`, `packageManager` to a pinned pnpm 10 release, and enable strict TypeScript including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

Use this minimum ignore policy so the temporary visual companion and secrets are never committed:

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
.superpowers/
*.log
apps/desktop/src-tauri/target/
```

- [ ] **Step 4: Install dependencies and run all workspace checks**

Run: `pnpm install && pnpm check:boundaries && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS; every package builds an empty public entry without platform imports.

- [ ] **Step 5: Commit the planning documents and foundation**

```bash
git add .
git commit -m "chore: initialize Simple Flame inventory monorepo"
```

### Task 2: Implement exact units and decimal quantities

**Files:**
- Create: `packages/domain/src/units/types.ts`
- Create: `packages/domain/src/units/convert.ts`
- Create: `packages/domain/src/units/quantity.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/units/convert.test.ts`
- Test: `packages/domain/src/units/quantity.property.test.ts`

**Interfaces:**
- Produces `BaseUnit`, `DisplayUnit`, `Quantity`, `convertQuantity`, `addQuantity`, and `compareQuantity`.
- All numeric values cross boundaries as canonical decimal strings.

- [ ] **Step 1: Write conversion tests including the 10 lb wax case**

```ts
import { describe, expect, it } from "vitest";
import { convertQuantity } from "./convert";

describe("convertQuantity", () => {
  it("converts a ten pound case to grams without display rounding", () => {
    expect(convertQuantity({ value: "10", unit: "POUND" }, "GRAM")).toEqual({
      value: "4535.9237",
      unit: "GRAM",
    });
  });

  it("does not convert volume to mass", () => {
    expect(() => convertQuantity({ value: "1", unit: "MILLILITER" }, "GRAM")).toThrow("incompatible dimensions");
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm missing exports**

Run: `pnpm --filter @simple-flame/domain test -- src/units/convert.test.ts`
Expected: FAIL because `convertQuantity` is undefined.

- [ ] **Step 3: Implement dimension-safe conversion**

```ts
export type BaseUnit = "GRAM" | "EACH" | "MILLILITER";
export type DisplayUnit = BaseUnit | "OUNCE" | "POUND";
export type Quantity<U extends DisplayUnit = DisplayUnit> = Readonly<{ value: string; unit: U }>;

const grams = { GRAM: "1", OUNCE: "28.349523125", POUND: "453.59237" } as const;

export function convertQuantity(input: Quantity, target: DisplayUnit): Quantity {
  // Use Decimal for every multiply/divide and normalize trailing zeroes.
  // Permit only mass-to-mass or identity conversions.
}
```

Implement property tests proving round-trip conversion remains within `0.0000001` gram and countable items remain integers.

- [ ] **Step 4: Run unit, property, type, and boundary tests**

Run: `pnpm --filter @simple-flame/domain test && pnpm typecheck && pnpm check:boundaries`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat: add exact inventory unit conversions"
```

### Task 3: Define versioned commands, events, and domain identities

**Files:**
- Create: `packages/contracts/src/common.ts`
- Create: `packages/contracts/src/inventory-commands.ts`
- Create: `packages/contracts/src/inventory-events.ts`
- Create: `packages/contracts/src/sync.ts`
- Create: `packages/domain/src/inventory/types.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/inventory-commands.test.ts`

**Interfaces:**
- Produces `InventoryCommandV1`, `InventoryEventV1`, `SyncPushRequestV1`, `SyncPushResultV1`, and typed conflict payloads.
- Consumed by every API, offline, PostgreSQL, and Phase 2 SQLite adapter.

- [ ] **Step 1: Write schema tests for valid receipt and invalid absolute overwrite**

```ts
it("accepts a versioned receive-stock command", () => {
  expect(InventoryCommandV1.parse(receiveStockFixture()).type).toBe("inventory.receive");
});

it("rejects unrecognized absolute quantity mutation", () => {
  expect(() => InventoryCommandV1.parse({ ...baseCommand(), type: "inventory.setQuantity", quantity: "10" })).toThrow();
});
```

- [ ] **Step 2: Run and confirm schema tests fail**

Run: `pnpm --filter @simple-flame/contracts test`
Expected: FAIL because command schemas do not exist.

- [ ] **Step 3: Implement discriminated command/event schemas**

```ts
const CommandEnvelope = z.object({
  version: z.literal(1),
  commandId: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorId: z.string().uuid(),
  deviceId: z.string().min(1),
  baseRevision: z.string().regex(/^\d+$/),
  occurredAtLocal: z.string().datetime(),
  queuedAt: z.string().datetime(),
});

export const InventoryCommandV1 = z.discriminatedUnion("type", [
  CommandEnvelope.extend({ type: z.literal("inventory.receive"), payload: ReceivePayload }),
  CommandEnvelope.extend({ type: z.literal("inventory.adjust"), payload: AdjustPayload }),
  CommandEnvelope.extend({ type: z.literal("production.complete"), payload: CompleteBatchPayload }),
  CommandEnvelope.extend({ type: z.literal("order.reserve"), payload: ReserveOrderPayload }),
  CommandEnvelope.extend({ type: z.literal("order.release"), payload: ReleaseOrderPayload }),
]);
```

Define conflict codes `REVISION_CHANGED`, `INSUFFICIENT_AVAILABLE`, `UNKNOWN_ITEM`, `RECIPE_RETIRED`, and `ORDER_STATE_CHANGED` with server snapshot, local intent, and allowed resolutions.

- [ ] **Step 4: Generate JSON Schema fixtures and run compatibility tests**

Run: `pnpm --filter @simple-flame/contracts test && pnpm typecheck`
Expected: PASS; committed fixture decoding proves backward compatibility.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/domain
git commit -m "feat: define inventory command and sync contracts"
```

### Task 4: Implement the immutable inventory ledger and PostgreSQL persistence

**Files:**
- Create: `packages/domain/src/inventory/project.ts`
- Create: `packages/persistence-contracts/src/inventory-ledger.ts`
- Create: `packages/persistence-postgres/src/schema/inventory.ts`
- Create: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.ts`
- Create: `packages/persistence-postgres/drizzle/0001_inventory_ledger.sql`
- Test: `packages/domain/src/inventory/project.test.ts`
- Test: `packages/persistence-contracts/src/inventory-ledger.contract.ts`
- Test: `packages/persistence-postgres/src/repositories/postgres-inventory-ledger.integration.test.ts`

**Interfaces:**
- Produces `InventoryLedgerRepository.appendOnce(commandId, entries)` and `getProjection(itemId, locationId)`.
- Produces immutable `LedgerEntry` and derived `InventoryProjection`.

- [ ] **Step 1: Write invariants for receipt, reservation, reversal, and duplicate command**

```ts
it("posts one receipt exactly once", async () => {
  await repo.appendOnce(commandId, [receiptEntry("160", "OUNCE")]);
  await repo.appendOnce(commandId, [receiptEntry("160", "OUNCE")]);
  expect(await repo.getProjection(waxId, locationId)).toMatchObject({ onHandBase: "4535.9237" });
});

it("uses a compensating entry instead of editing history", async () => {
  const before = await repo.listEntries(waxId);
  await repo.appendOnce(reversalId, [reverseEntry(before[0]!.id)]);
  expect((await repo.listEntries(waxId)).length).toBe(2);
});
```

- [ ] **Step 2: Run contract tests and confirm the adapter is missing**

Run: `pnpm --filter @simple-flame/persistence-postgres test`
Expected: FAIL at repository construction.

- [ ] **Step 3: Add tables and transactional append semantics**

```sql
CREATE TABLE processed_commands (
  command_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  result_json jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_ledger_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  command_id uuid NOT NULL REFERENCES processed_commands(command_id),
  cause text NOT NULL,
  on_hand_delta numeric(24,8) NOT NULL DEFAULT 0,
  reserved_delta numeric(24,8) NOT NULL DEFAULT 0,
  incoming_delta numeric(24,8) NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
```

Lock each affected projection row, reject any committed state that would make on-hand or reserved invalid, append events and processed-command result in one transaction, and expose a read projection view.

- [ ] **Step 4: Run disposable-PostgreSQL migration and contract suite**

Run: `pnpm --filter @simple-flame/persistence-postgres test:integration`
Expected: PASS for first execution, duplicate execution, concurrent reservation, rollback, and compensating entry.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/persistence-contracts packages/persistence-postgres
git commit -m "feat: add immutable PostgreSQL inventory ledger"
```

### Task 5: Add items, recipe versions, process loss, and exact capacity

**Files:**
- Create: `packages/domain/src/items/item.ts`
- Create: `packages/domain/src/recipes/recipe.ts`
- Create: `packages/domain/src/capacity/calculate-capacity.ts`
- Create: `packages/persistence-postgres/src/schema/catalog.ts`
- Create: `packages/persistence-postgres/drizzle/0002_items_recipes.sql`
- Create: `packages/test-kit/src/fixtures/current-candle.ts`
- Test: `packages/domain/src/capacity/calculate-capacity.test.ts`
- Test: `packages/domain/src/capacity/calculate-capacity.property.test.ts`

**Interfaces:**
- Produces `RecipeVersion`, `RecipeComponent`, `LossPolicy`, `CapacityInput`, and `CapacityResult`.
- `calculateCapacity(input)` returns theoretical, adjusted, limiting components, and quantity needed for one more unit.

- [ ] **Step 1: Write the permanent current-recipe capacity tests**

```ts
it("finds wax as the limit for the current 17 oz recipe", () => {
  const result = calculateCapacity(currentCandleCapacityInput({ waxOunces: "157", allEachComponents: "20", fragranceOunces: "26" }));
  expect(result.adjustedUnits).toBe(10);
  expect(result.limitingItemIds).toEqual([goldenWaxId]);
});

it("applies fixed loss once per configured batch", () => {
  const result = calculateCapacity(currentCandleCapacityInput({ waxOunces: "158", waxLoss: { mode: "FIXED_PER_BATCH", fixedBase: ounce("1"), batchSize: 10 } }));
  expect(result.adjustedUnits).toBe(10);
  expect(result.theoreticalUnits).toBe(10);
});
```

- [ ] **Step 2: Run and confirm capacity tests fail**

Run: `pnpm --filter @simple-flame/domain test -- src/capacity`
Expected: FAIL because the engine is absent.

- [ ] **Step 3: Implement monotonic capacity search and explanation output**

```ts
export function requiredForUnits(component: RecipeComponent, units: bigint): Decimal {
  const batches = new Decimal(units.toString()).div(component.loss.batchSize).ceil();
  return new Decimal(component.perUnitBase)
    .mul(units.toString())
    .mul(new Decimal(1).plus(component.loss.percentage))
    .plus(batches.mul(component.loss.fixedPerBatchBase));
}
```

Find the maximum integer units per component with exponential upper-bound growth followed by binary search. Compare all components and return ties as multiple limiting items. Keep theoretical and adjusted paths separate.

- [ ] **Step 4: Add item/recipe migrations and seed current recipe fixture**

Run: `pnpm --filter @simple-flame/domain test && pnpm --filter @simple-flame/persistence-postgres test:integration`
Expected: PASS including zero inventory, protected stock toggle, percent loss, fixed batch loss, both loss modes, disabled loss, and two future sizes.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/persistence-postgres packages/test-kit
git commit -m "feat: calculate candle capacity from versioned recipes"
```

### Task 6: Implement shared-material production allocation

**Files:**
- Create: `packages/domain/src/allocation/allocate-production.ts`
- Create: `packages/domain/src/allocation/priority.ts`
- Test: `packages/domain/src/allocation/allocate-production.test.ts`
- Test: `packages/domain/src/allocation/no-double-count.property.test.ts`

**Interfaces:**
- Produces `allocateProduction(request): AllocationResult` with planned, partial, blocked, residual inventory, and explanations.

- [ ] **Step 1: Write a no-double-counting scenario**

```ts
it("does not promise the same shared wax to two scents", () => {
  const result = allocateProduction(twoScentsSharingWax({ waxForCandles: 10, firstRequested: 8, secondRequested: 8 }));
  expect(result.lines.map((line) => line.allocatedUnits)).toEqual([8, 2]);
  expect(result.residualByItem[goldenWaxId]).toBe("0");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @simple-flame/domain test -- src/allocation`
Expected: FAIL because allocation functions are missing.

- [ ] **Step 3: Implement stable priority and sequential reservation simulation**

```ts
export const comparePriority = (a: ProductionDemand, b: ProductionDemand) =>
  compareDate(a.paidOrderDueAt, b.paidOrderDueAt) ||
  Number(b.orderShortfallUnits > 0) - Number(a.orderShortfallUnits > 0) ||
  b.ownerPriority - a.ownerPriority ||
  compareDate(a.forecastStockoutAt, b.forecastStockoutAt) ||
  b.salesVelocity.cmp(a.salesVelocity) ||
  a.sku.localeCompare(b.sku);
```

For each sorted line, binary-search the maximum feasible allocation against residual shared inventory and return the component shortages for the unallocated remainder.

- [ ] **Step 4: Run example and property tests**

Run: `pnpm --filter @simple-flame/domain test -- src/allocation && pnpm typecheck`
Expected: PASS; property tests prove summed consumption never exceeds initial availability.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/allocation
git commit -m "feat: allocate shared materials across production plans"
```

### Task 7: Add lots, FIFO proposals, and atomic production batches

**Files:**
- Create: `packages/domain/src/lots/select-fifo.ts`
- Create: `packages/application/src/production/complete-batch.ts`
- Create: `packages/persistence-postgres/src/schema/production.ts`
- Create: `packages/persistence-postgres/drizzle/0003_lots_production.sql`
- Test: `packages/domain/src/lots/select-fifo.test.ts`
- Test: `packages/application/src/production/complete-batch.test.ts`

**Interfaces:**
- Produces `selectFifoLots`, `CompleteProductionBatch`, and traceable `ProductionBatchResult`.

- [ ] **Step 1: Write FIFO and rollback tests**

```ts
it("selects received date then best-by date deterministically", () => {
  expect(selectFifoLots(lotFixture(), "12").map((x) => x.lotId)).toEqual([olderLotId, newerLotId]);
});

it("rolls back every consumption when finished output cannot post", async () => {
  await expect(useCase.execute(invalidFinishedSkuBatch())).rejects.toThrow("finished item unavailable");
  expect(await ledger.listEntriesByBatch(batchId)).toEqual([]);
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `pnpm --filter @simple-flame/domain test -- src/lots && pnpm --filter @simple-flame/application test -- src/production`
Expected: FAIL.

- [ ] **Step 3: Implement lot selection and one-transaction batch completion**

```ts
export interface CompleteProductionBatchDeps {
  transaction: TransactionRunner;
  recipes: RecipeRepository;
  lots: LotRepository;
  ledger: InventoryLedgerRepository;
  clock: Clock;
}
```

Within one transaction: validate recipe version, validate/material reservations, select or validate lot overrides, post consumption and explicit loss, post finished output, release plan reservations, and store traceability links.

- [ ] **Step 4: Run domain, application, and PostgreSQL integration tests**

Run: `pnpm --filter @simple-flame/domain test && pnpm --filter @simple-flame/application test && pnpm --filter @simple-flame/persistence-postgres test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/application packages/persistence-postgres
git commit -m "feat: record traceable candle production batches"
```

### Task 8: Implement orders, reservations, and separate shipping readiness

**Files:**
- Create: `packages/domain/src/orders/evaluate-order.ts`
- Create: `packages/domain/src/orders/packing-rules.ts`
- Create: `packages/application/src/orders/apply-order-state.ts`
- Create: `packages/persistence-postgres/src/schema/orders.ts`
- Create: `packages/persistence-postgres/drizzle/0004_orders_packing.sql`
- Test: `packages/domain/src/orders/evaluate-order.test.ts`
- Test: `packages/application/src/orders/apply-order-state.test.ts`

**Interfaces:**
- Produces `OrderReadinessResult` and idempotent paid/canceled/refunded/fulfilled transitions.

- [ ] **Step 1: Write finished-first and shipping-separation tests**

```ts
it("uses finished goods before production capacity", () => {
  const result = evaluateOrder(orderFixture({ ordered: 5, finished: 3, makeable: 4 }));
  expect(result.finishedAllocated).toBe(3);
  expect(result.productionRequired).toBe(2);
  expect(result.productionStatus).toBe("MAKEABLE_BEFORE_DUE");
});

it("does not reduce candle capacity when a shipping box is missing", () => {
  const result = evaluateOrder(orderFixture({ ordered: 2, finished: 2, shippingBoxes: 0 }));
  expect(result.productionStatus).toBe("READY_FROM_FINISHED");
  expect(result.fulfillmentStatus).toBe("BLOCKED_FULFILLMENT_MATERIAL");
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/domain test -- src/orders`
Expected: FAIL.

- [ ] **Step 3: Implement readiness statuses and transition commands**

```ts
export type ProductionReadiness = "READY_FROM_FINISHED" | "MAKEABLE_BEFORE_DUE" | "PARTIAL" | "BLOCKED_PRODUCTION";
export type FulfillmentReadiness = "READY" | "BLOCKED_FULFILLMENT_MATERIAL" | "READY_WITH_ADVISORY_WARNINGS";
```

Paid orders reserve finished goods immediately. Cancellation/refund releases only active reservations. Fulfillment consumes finished goods and matching packing-rule components exactly once.

- [ ] **Step 4: Run lifecycle and concurrency tests**

Run: `pnpm --filter @simple-flame/domain test -- src/orders && pnpm --filter @simple-flame/application test -- src/orders`
Expected: PASS for paid, repeated paid event, partial refund, cancel, fulfill, and out-of-order events.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/application packages/persistence-postgres
git commit -m "feat: evaluate order production and shipping readiness"
```

### Task 9: Add vendors, inbound purchases, and reorder recommendations

**Files:**
- Create: `packages/domain/src/purchasing/recommend.ts`
- Create: `packages/application/src/purchasing/mark-ordered.ts`
- Create: `packages/application/src/purchasing/receive-purchase.ts`
- Create: `packages/persistence-postgres/src/schema/purchasing.ts`
- Create: `packages/persistence-postgres/drizzle/0005_vendors_purchasing.sql`
- Test: `packages/domain/src/purchasing/recommend.test.ts`
- Test: `packages/application/src/purchasing/purchase-lifecycle.test.ts`

**Interfaces:**
- Produces `PurchaseRecommendation`, `ExpectedInbound`, vendor grouping, mark-ordered, and receive workflows.

- [ ] **Step 1: Write pack-size/MOQ/lead-time tests**

```ts
it("rounds up to pack size and minimum order", () => {
  const result = recommendPurchase(policy({ shortage: "13", packSize: "12", minimum: "24", reorderMultiple: "12" }));
  expect(result.recommendedPurchaseUnits).toBe("24");
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/domain test -- src/purchasing`
Expected: FAIL.

- [ ] **Step 3: Implement explainable reorder calculations**

```ts
const reorderPoint = leadTimeDemand.plus(safetyDaysDemand).plus(protectedStock);
const rawNeed = targetCoverageDemand.minus(available).minus(usableIncoming);
const recommended = roundUpToVendorRules(Decimal.max(0, rawNeed), vendorOffer);
```

Persist preferred/alternate vendors, URLs, price history, lead days, MOQ, pack conversion, expected receipt, actual receipt, and lot creation.

- [ ] **Step 4: Run focused and integration tests**

Run: `pnpm --filter @simple-flame/domain test -- src/purchasing && pnpm --filter @simple-flame/application test -- src/purchasing`
Expected: PASS including overdue inbound and partial receipt.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/application packages/persistence-postgres
git commit -m "feat: recommend and receive vendor purchases"
```

### Task 10: Implement auditable 30/60/90-day forecasting

**Files:**
- Create: `packages/domain/src/forecast/calculate-forecast.ts`
- Create: `packages/domain/src/forecast/seasonality.ts`
- Create: `packages/application/src/forecast/rebuild-forecast.ts`
- Create: `packages/persistence-postgres/src/schema/forecast.ts`
- Test: `packages/domain/src/forecast/calculate-forecast.test.ts`

**Interfaces:**
- Produces `ForecastResult` with component inputs, redistributed weights, seasonal factor, manual events, override, and projected stockout date.

- [ ] **Step 1: Write weight redistribution and manual-event tests**

```ts
it("redistributes prior-year weight when only 90 days exist", () => {
  const result = calculateForecast(historyFixture({ days: 90, priorYear: false }), 30);
  expect(result.weights).toEqual({ recent30: "0.625", recent90: "0.375", priorYear: "0" });
});

it("shows manual market demand separately", () => {
  const result = calculateForecast(historyFixture(), 30, [{ units: 40, reason: "October market" }]);
  expect(result.manualDemandUnits).toBe(40);
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/domain test -- src/forecast`
Expected: FAIL.

- [ ] **Step 3: Implement weighted windows and clamped seasonality**

```ts
const baseWeights = { recent30: new Decimal("0.5"), recent90: new Decimal("0.3"), priorYear: new Decimal("0.2") };
const seasonalFactor = Decimal.max("0.5", Decimal.min("2.0", computedSeasonalIndex));
```

Store computed and overridden forecasts separately; overrides require reason and expiration. Include source-history coverage and every arithmetic input in the result.

- [ ] **Step 4: Run deterministic clock and edge-case tests**

Run: `pnpm --filter @simple-flame/domain test -- src/forecast && pnpm --filter @simple-flame/application test -- src/forecast`
Expected: PASS for no history, 30 days, 90 days, 12 months, leap day, refunds, zero sales, manual events, and expiring override.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/application packages/persistence-postgres
git commit -m "feat: add explainable inventory demand forecasts"
```

### Task 11: Build the authenticated command API, audit log, and job runner

**Files:**
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/plugins/auth.ts`
- Create: `apps/api/src/routes/commands.ts`
- Create: `apps/api/src/routes/read-model.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/worker/src/runner.ts`
- Create: `packages/persistence-postgres/src/schema/platform.ts`
- Create: `packages/persistence-postgres/drizzle/0006_auth_audit_jobs.sql`
- Test: `apps/api/src/routes/commands.test.ts`
- Test: `apps/worker/src/runner.test.ts`

**Interfaces:**
- Produces `POST /v1/sync/push`, `GET /v1/sync/pull`, read-model endpoints, health/readiness endpoints, append-only audit, and leased jobs.

- [ ] **Step 1: Write API idempotency, authorization, CSRF, and job-lease tests**

```ts
it("returns the original result for a duplicate command id", async () => {
  const first = await api.inject(pushCommand(command));
  const second = await api.inject(pushCommand(command));
  expect(second.json()).toEqual(first.json());
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `pnpm --filter @simple-flame/api test && pnpm --filter @simple-flame/worker test`
Expected: FAIL.

- [ ] **Step 3: Implement server composition and transaction-scoped command handling**

```ts
app.post("/v1/sync/push", { preHandler: [requireSession, verifyCsrf] }, async (request, reply) => {
  const input = SyncPushRequestV1.parse(request.body);
  const result = await commandBus.push(input, request.session);
  return reply.code(200).send(SyncPushResultV1.parse(result));
});
```

Use Supabase Auth email magic link/OTP for identity. The API callback verifies the token hash with Supabase, creates an opaque application session stored in PostgreSQL, and returns only a secure HTTP-only same-site cookie. Configure custom production SMTP. Add database roles, structured audit events, request IDs, rate limits, and redacted structured logging.

- [ ] **Step 4: Implement PostgreSQL job claiming with `FOR UPDATE SKIP LOCKED`**

Run: `pnpm --filter @simple-flame/api test && pnpm --filter @simple-flame/worker test && pnpm typecheck`
Expected: PASS including lease expiry, bounded retry, dead letter, duplicate command, invalid role, stale CSRF, and redaction.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker packages/persistence-postgres
git commit -m "feat: add authenticated command API and worker jobs"
```

### Task 12: Integrate Square catalog, orders, inventory, OAuth, and webhooks in read mode

**Files:**
- Create: `apps/api/src/routes/square-oauth.ts`
- Create: `apps/api/src/routes/square-webhook.ts`
- Create: `apps/worker/src/jobs/square-reconcile.ts`
- Create: `packages/application/src/integrations/square/square-gateway.ts`
- Create: `packages/application/src/integrations/square/import-catalog.ts`
- Create: `packages/application/src/integrations/square/apply-order-event.ts`
- Create: `packages/persistence-postgres/src/schema/integrations.ts`
- Test: `apps/api/src/routes/square-webhook.test.ts`
- Test: `packages/application/src/integrations/square/import-catalog.test.ts`
- Test: `packages/application/src/integrations/square/apply-order-event.test.ts`

**Interfaces:**
- Produces encrypted seller connection, catalog-variation mapping, paid-order lifecycle, webhook inbox, and scheduled reconciliation cursor.

- [ ] **Step 1: Write raw-body signature and event-idempotency tests**

```ts
it("rejects an invalid Square signature before persisting", async () => {
  const response = await api.inject({ method: "POST", url: "/webhooks/square", headers: signature("invalid"), payload: rawEvent });
  expect(response.statusCode).toBe(403);
  expect(await webhookInbox.count()).toBe(0);
});
```

- [ ] **Step 2: Confirm Square integration tests fail**

Run: `pnpm --filter @simple-flame/api test -- square && pnpm --filter @simple-flame/application test -- square`
Expected: FAIL.

- [ ] **Step 3: Implement server-side OAuth code flow and encrypted token storage**

Request read scopes only. Refresh tokens in the worker before expiry. Handle `oauth.authorization.revoked` by disabling jobs and raising an alert. Never expose tokens to the PWA.

```ts
export interface SquareGateway {
  listCatalog(cursor?: string): Promise<CatalogPage>;
  searchOrders(input: OrderSearchInput): Promise<OrderPage>;
  retrieveOrder(id: string): Promise<SquareOrderSnapshot>;
  batchRetrieveInventory(variationIds: string[]): Promise<SquareInventorySnapshot[]>;
}
```

- [ ] **Step 4: Implement webhook inbox plus reconciliation**

Validate signature against the raw body and exact configured URL, persist event ID once, enqueue processing, retrieve current Square resource state, map variations, and apply paid/canceled/refunded/fulfilled transitions idempotently. Reconciliation compares a stored cursor/time window and repairs missed events.

- [ ] **Step 5: Run fake-gateway tests and Square Sandbox suite**

Run: `pnpm test:square:sandbox`
Expected: PASS for OAuth, pagination, catalog variation mapping, paid order, fulfillment update, cancellation, refund, repeated webhook, out-of-order webhook, suppressed webhook recovered by reconciliation, and revoked auth.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/worker packages/application packages/persistence-postgres
git commit -m "feat: synchronize Square catalog and order lifecycle"
```

### Task 13: Implement the PWA IndexedDB projection, offline outbox, and conflicts

**Files:**
- Create: `packages/persistence-indexeddb/src/database.ts`
- Create: `packages/persistence-indexeddb/src/outbox.ts`
- Create: `packages/persistence-indexeddb/src/read-model.ts`
- Create: `packages/sync/src/sync-machine.ts`
- Create: `packages/sync/src/resolve-conflict.ts`
- Create: `apps/web/src/service-worker.ts`
- Create: `apps/web/src/offline/sync-controller.ts`
- Test: `packages/persistence-contracts/src/outbox.contract.ts`
- Test: `packages/persistence-indexeddb/src/outbox.contract.test.ts`
- Test: `packages/sync/src/sync-machine.test.ts`

**Interfaces:**
- Produces `LocalStore`, `OutboxRepository`, `SyncMachine`, and `ConflictResolutionCommand` shared with Phase 2.

- [ ] **Step 1: Write browser persistence and restart tests**

```ts
it("retains an unsent command across store reopen", async () => {
  await first.outbox.enqueue(command);
  await first.close();
  const reopened = await openTestDatabase(databaseName);
  expect(await reopened.outbox.pending()).toEqual([command]);
});
```

- [ ] **Step 2: Confirm IndexedDB and sync tests fail**

Run: `pnpm --filter @simple-flame/persistence-indexeddb test && pnpm --filter @simple-flame/sync test`
Expected: FAIL.

- [ ] **Step 3: Implement explicit outbox states and sync transitions**

```ts
export type OutboxState = "PENDING" | "SENDING" | "ACCEPTED" | "CONFLICT" | "RETRYABLE";
export type SyncState = "OFFLINE" | "SYNCING" | "CURRENT" | "STALE" | "NEEDS_REVIEW";
```

Store command, base revision, attempts, last error category, and server result. Upload in local order. Never delete a pending/conflicted command until accepted or explicitly superseded by a resolution command.

- [ ] **Step 4: Add application-shell caching without caching secrets or mutation responses**

Cache versioned static assets and safe GET read models. Use Workbox replay only to wake the explicit sync controller. Request persistent browser storage and show a warning if denied.

- [ ] **Step 5: Run Chromium and WebKit offline tests**

Run: `pnpm --filter @simple-flame/web test:offline`
Expected: PASS for browser restart, queued receipt, queued batch, stale timestamp, duplicate replay, server revision conflict, compensating resolution, and refreshed projection.

- [ ] **Step 6: Commit**

```bash
git add packages/persistence-indexeddb packages/sync apps/web
git commit -m "feat: add durable PWA offline synchronization"
```

### Task 14: Build the branded accessible application interface

**Files:**
- Create: `packages/ui/src/theme/tokens.css`
- Create: `packages/ui/src/components/StatusBadge.tsx`
- Create: `packages/ui/src/components/DataFreshness.tsx`
- Create: `packages/ui/src/layout/AppShell.tsx`
- Create: feature views under `packages/ui/src/features/`
- Create: routes under `apps/web/src/routes/`
- Create: `apps/web/src/main.tsx`
- Test: component tests beside each component
- Test: `apps/web/e2e/navigation.spec.ts`
- Test: `apps/web/e2e/keyboard-accessibility.spec.ts`

**Interfaces:**
- Consumes application view models only; UI components do not calculate inventory.
- Produces dashboard, inventory, products/recipes, orders, production, purchasing, forecast, sync/settings screens.

- [ ] **Step 1: Write freshness, blocker, keyboard, and color-independent status tests**

```tsx
render(<DataFreshness online={false} lastAuthoritativeSync="2026-08-15T14:30:00Z" pendingCommands={2} />);
expect(screen.getByText(/Data accurate as of/)).toBeVisible();
expect(screen.getByText(/2 changes waiting to sync/)).toBeVisible();
```

- [ ] **Step 2: Confirm UI tests fail**

Run: `pnpm --filter @simple-flame/ui test && pnpm --filter @simple-flame/web test:e2e`
Expected: FAIL.

- [ ] **Step 3: Implement tokens and application shell**

```css
:root {
  --sf-canvas: #f5f3ef;
  --sf-primary: #4d4333;
  --sf-dark: #2b2823;
  --sf-muted: #6c6b6a;
  --sf-heading: "Playfair Display", Georgia, serif;
  --sf-body: Inter, system-ui, sans-serif;
}
```

Create responsive navigation and action-first dashboard. Every blocker exposes explanation and direct remediation. Every capacity card labels hypothetical versus allocated quantities.

- [ ] **Step 4: Implement feature views against fake application services**

Use shared view-model interfaces. Include empty/loading/error/offline/conflict states with real recovery actions. Keep customer PII out of dashboard and Sheets-facing views.

- [ ] **Step 5: Run component, Playwright, axe, keyboard, and visual regression tests**

Run: `pnpm --filter @simple-flame/ui test && pnpm --filter @simple-flame/web test:e2e && pnpm --filter @simple-flame/web test:a11y`
Expected: PASS in Chromium and WebKit at desktop and narrow widths.

- [ ] **Step 6: Commit**

```bash
git add packages/ui apps/web
git commit -m "feat: add branded inventory operations interface"
```

### Task 15: Implement Google Sheets mirror and validated adjustment import

**Files:**
- Create: `packages/application/src/integrations/sheets/sheets-gateway.ts`
- Create: `packages/application/src/integrations/sheets/build-snapshot.ts`
- Create: `packages/application/src/integrations/sheets/preview-adjustments.ts`
- Create: `apps/worker/src/jobs/publish-sheets.ts`
- Create: `apps/api/src/routes/google-oauth.ts`
- Create: `apps/api/src/routes/sheets-import.ts`
- Test: `packages/application/src/integrations/sheets/build-snapshot.test.ts`
- Test: `packages/application/src/integrations/sheets/preview-adjustments.test.ts`

**Interfaces:**
- Produces atomic labeled snapshot publication and explicit preview/confirm import.

- [ ] **Step 1: Write snapshot consistency and invalid-row tests**

```ts
it("labels every sheet with one snapshot id and generated time", () => {
  const snapshot = buildSheetsSnapshot(readModelFixture());
  expect(new Set(snapshot.tabs.map((tab) => tab.snapshotId)).size).toBe(1);
});

it("blocks an unknown SKU without posting valid rows during preview", async () => {
  const preview = await previewAdjustments([validRow(), row({ sku: "UNKNOWN" })]);
  expect(preview.canConfirm).toBe(false);
  expect(await ledger.count()).toBe(0);
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/application test -- sheets`
Expected: FAIL.

- [ ] **Step 3: Implement least-privilege Google OAuth and atomic snapshot writer**

Use `drive.file` plus `spreadsheets` only for the selected workbook. Batch structural/value changes, back off on 429/5xx, and publish the new snapshot marker only after every tab succeeds.

- [ ] **Step 4: Implement preview and confirmation workflow**

Parse only `Approved Adjustments`. Validate row ID, SKU, unit, direction, reason, effective date, stale snapshot, resulting quantity, and duplicate import. Confirmation converts accepted rows into normal `inventory.adjust` commands.

- [ ] **Step 5: Run fake API and Google integration tests**

Run: `pnpm test:sheets:integration`
Expected: PASS for workbook creation, protected tabs, atomic update, quota retry, invalid rows, duplicate IDs, stale snapshot, explicit confirmation, and result writeback.

- [ ] **Step 6: Commit**

```bash
git add packages/application apps/api apps/worker
git commit -m "feat: mirror inventory to Google Sheets safely"
```

### Task 16: Add alerts, digest scheduling, and integration-health operations

**Files:**
- Create: `packages/domain/src/alerts/derive-alerts.ts`
- Create: `packages/application/src/notifications/build-digest.ts`
- Create: `packages/application/src/notifications/email-gateway.ts`
- Create: `apps/worker/src/jobs/rebuild-alerts.ts`
- Create: `apps/worker/src/jobs/send-digests.ts`
- Create: `packages/persistence-postgres/src/schema/alerts.ts`
- Test: `packages/domain/src/alerts/derive-alerts.test.ts`
- Test: `packages/application/src/notifications/build-digest.test.ts`

**Interfaces:**
- Produces deduplicated in-app alerts, configurable immediate emails, and daily/weekly/monthly digests.

- [ ] **Step 1: Write alert-severity, deduplication, and digest-window tests**

```ts
it("does not classify an advisory shortage as a production blocker", () => {
  expect(deriveAlerts(advisoryShortage()).map((a) => a.kind)).toEqual(["ADVISORY_REORDER"]);
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/domain test -- alerts && pnpm --filter @simple-flame/application test -- notifications`
Expected: FAIL.

- [ ] **Step 3: Implement stable alert fingerprints and digest contents**

Fingerprint on organization, kind, resource, and risk window. Reopen resolved alerts only when source revision changes. Digests include immediate actions, order risks, 86 status, purchasing, inbound, lots, sync health, and 30/60/90 forecasts.

- [ ] **Step 4: Implement provider-neutral email gateway and fake provider**

```ts
export interface EmailGateway {
  send(message: { idempotencyKey: string; to: string; subject: string; html: string; text: string }): Promise<{ providerId: string }>;
}
```

- [ ] **Step 5: Run time-zone, retry, and duplicate-send tests**

Run: `pnpm --filter @simple-flame/worker test && pnpm --filter @simple-flame/application test -- notifications`
Expected: PASS across DST, frequency changes, worker retry, and duplicate job delivery.

- [ ] **Step 6: Commit**

```bash
git add packages/domain packages/application apps/worker packages/persistence-postgres
git commit -m "feat: add inventory alerts and forecast digests"
```

### Task 17: Add guarded Square 86/un-86 writeback

**Files:**
- Create: `packages/application/src/integrations/square/propose-availability-change.ts`
- Create: `packages/application/src/integrations/square/execute-availability-change.ts`
- Create: `apps/api/src/routes/square-availability.ts`
- Create: `apps/worker/src/jobs/automatic-square-availability.ts`
- Test: `packages/application/src/integrations/square/availability-change.test.ts`
- Test: `apps/api/src/routes/square-availability.test.ts`

**Interfaces:**
- Produces manual proposal/approval and opt-in automatic execution with audit and reversal suggestion.

- [ ] **Step 1: Write default-disabled and stale-data tests**

```ts
it("does not execute automatically when global automation is disabled", async () => {
  await automaticJob.run(atRiskProduct());
  expect(square.writeCalls).toHaveLength(0);
  expect(await proposals.open()).toHaveLength(1);
});

it("blocks writeback when Square sync is stale", async () => {
  await expect(executeAvailabilityChange(staleProposal())).rejects.toThrow("Square data is stale");
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm --filter @simple-flame/application test -- availability && pnpm --filter @simple-flame/api test -- availability`
Expected: FAIL.

- [ ] **Step 3: Implement proposal and second-check execution**

Before any write: verify `ITEMS_WRITE`/`INVENTORY_WRITE`, current setting, recent sync, current product mapping, current capacity, no usable current finished goods, and no contradictory owner action. Store Square before/after snapshot and idempotency key.

- [ ] **Step 4: Run Sandbox approval and automatic-mode tests**

Run: `pnpm test:square:writeback:sandbox`
Expected: PASS for proposal-only default, owner approval, canceled proposal, per-product override, opt-in automatic 86, guarded auto-un-86, repeated job, API failure, and audit record.

- [ ] **Step 5: Commit**

```bash
git add packages/application apps/api apps/worker
git commit -m "feat: add guarded Square availability writeback"
```

### Task 18: Complete end-to-end verification, backup restore, and deployment readiness

**Files:**
- Create: `apps/web/e2e/golden-operations.spec.ts`
- Create: `apps/web/e2e/offline-conflict.spec.ts`
- Create: `apps/api/src/observability/metrics.ts`
- Create: `Dockerfile.api`
- Create: `Dockerfile.worker`
- Create: `compose.yaml`
- Create: `docs/operations/local-setup.md`
- Create: `docs/operations/square-setup.md`
- Create: `docs/operations/google-sheets-setup.md`
- Create: `docs/operations/backup-restore.md`
- Create: `docs/operations/incident-response.md`
- Create: `docs/operations/launch-checklist.md`
- Test: `scripts/restore-rehearsal.ps1`

**Interfaces:**
- Produces deployable containers, operational documentation, metrics, and the release acceptance gate.

- [ ] **Step 1: Write the golden end-to-end scenario before implementation glue**

```ts
test("paid order can be produced, packed, forecast, and reordered", async ({ page, context }) => {
  await seedCurrentRecipeAndInventory();
  await importPaidSquareOrder({ quantity: 5 });
  await expectOrderProductionShortfall(page, 2);
  await completeProductionBatch(page, 2);
  await expectOrderProductionReady(page);
  await expectShippingBlocker(page, "Small shipping box");
  await expectPurchaseRecommendation(page, "Small shipping box");
});
```

- [ ] **Step 2: Run full suite and record failures without weakening assertions**

Run: `pnpm lint && pnpm typecheck && pnpm check:boundaries && pnpm test && pnpm test:e2e`
Expected: initial FAIL only for missing integration glue or operations assets.

- [ ] **Step 3: Add containers, metrics, readiness checks, and redaction checks**

Expose health separately from dependency readiness. Record command conflicts, job lag, webhook age, Square/Sheets last success, outbox backlog, forecast age, and dead-letter count without item/customer secrets.

- [ ] **Step 4: Execute restore rehearsal**

Run: `pwsh ./scripts/restore-rehearsal.ps1`
Expected: create fixture data, back up PostgreSQL, restore into a fresh database, verify ledger hash/counts, recipes, orders, audit rows, and application readiness.

- [ ] **Step 5: Run the complete acceptance matrix**

Run: `pnpm verify:release`
Expected: PASS for lint, typecheck, architecture boundaries, unit/property tests, adapter contracts, migrations, API, worker, Square Sandbox read/write suites, Sheets integration, Chromium/WebKit PWA flows, offline restart/conflict, accessibility, backup restore, and production build.

- [ ] **Step 6: Perform mandatory two-stage review**

First review spec compliance against every acceptance criterion in the design document. Second review code quality, security, migration safety, offline durability, and desktop-readiness boundaries. Resolve every severity-1/2 finding and rerun `pnpm verify:release`.

- [ ] **Step 7: Commit release readiness**

```bash
git add .
git commit -m "chore: verify Phase 1 production readiness"
```

## Phase 1 self-review

- Spec coverage: every confirmed requirement maps to Tasks 2–18.
- Placeholder scan: implementation values are specified; operator data remains configurable by design.
- Type consistency: all platforms use the same decimal-string quantities, V1 commands/events, repository ports, and sync conflicts.
- Desktop readiness: shared packages are protected by Task 1 boundaries and Task 13 produces storage/sync contracts reused by Phase 2.
- Critical sequencing: exact math and immutable ledger precede UI and integrations; Square writeback remains the penultimate feature.
