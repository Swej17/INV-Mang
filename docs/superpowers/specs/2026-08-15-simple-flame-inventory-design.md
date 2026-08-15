# Simple Flame Inventory Management System Design

**Status:** Approved requirements consolidated for implementation planning
**Primary operator:** One owner/operator on macOS
**Delivery sequence:** Phase 1 local-first web/PWA, followed by Phase 2 native Mac desktop shell
**Brand reference:** [The Simple Flame Co.](https://www.thesimpleflame.com/)
**Implementation repository:** [Swej17/INV-Mang](https://github.com/Swej17/INV-Mang), `main` at initial commit `19eb66d` when this design was finalized

## 1. Product intent

Build an inventory and production-planning system that answers four operational questions accurately:

1. How many candles of each product can be made from current materials?
2. How many candles can be made across an allocated multi-product production plan without double-counting shared materials?
3. Can each paid order be completed from finished stock, newly produced candles, and required shipping supplies?
4. What should be reordered, from which preferred vendor, in what quantity, and by what date?

The app must combine Square catalog/order data with manually managed materials that Square cannot model, including wax, fragrance, vessels, wicks, labels, lids, boxes, filler, and miscellaneous supplies. Square remains the commerce system. The new app becomes the authoritative manufacturing-material and production ledger.

## 2. Confirmed requirements

- Sync Square catalog items, variations, orders, fulfillments, and relevant finished-goods inventory.
- Allow local-only products, ingredients, packaging, shipping supplies, and advisory items.
- Track finished candles separately from ingredients.
- Calculate per-product hypothetical capacity and a non-double-counted allocated production plan.
- Use finished goods before calculating an order's production shortfall.
- Show production readiness separately from packing/shipping readiness.
- Support current and future candle sizes through reusable recipe templates.
- Work without internet for core inventory transactions and manual orders.
- Always show the latest authoritative synchronization timestamp while offline.
- Reconcile offline transactions after reconnection instead of silently overwriting quantities.
- Mirror authoritative data into Google Sheets and accept only validated, previewed imports from a controlled adjustment template.
- Generate in-app alerts plus daily, weekly, or monthly email digests with 30/60/90-day forecasts.
- Support optional lot, received-date, best-by-date, and FIFO handling.
- Support optional protected stock and optional wax/fragrance process-loss settings.
- Support purchase units, recipe units, automatic conversion, pack sizes, minimum order quantities, and vendor product URLs.
- Default Square 86/un-86 changes to manual approval, with a separately enabled automatic mode.
- Design role support for Owner/Admin, Production, and Fulfillment while optimizing the interface for one owner.
- Prepare the Phase 1 codebase so the Phase 2 Mac app reuses domain rules, contracts, UI, synchronization, and tests.

## 3. Explicit non-goals

- The app does not place vendor purchases or initiate payments.
- Google Sheets is not a second live database and arbitrary workbook edits do not change inventory.
- The first release does not create carrier labels, calculate postage, or replace Square fulfillment.
- The first release does not implement accounting, payroll, CRM, or general ERP features.
- The first release exposes one active business location in the interface; the schema retains location identifiers for future Square-location support.
- The first release does not use opaque machine-learning forecasts. Every forecast and purchase recommendation must show its inputs.
- The app does not automatically modify Square availability until the owner explicitly enables that option.

## 4. Brand and interaction direction

The interface should feel like an internal extension of The Simple Flame storefront: quiet, intentional, simple, and premium rather than like a generic warehouse dashboard.

Use these starting tokens, verified from the public site:

- Canvas/background: `#F5F3EF`.
- Primary brown: `#4D4333`.
- Dark neutral: `#2B2823`.
- Muted neutral: `#6C6B6A`.
- Heading typeface: Playfair Display, weight 400 unless hierarchy requires otherwise.
- Interface/body typeface: Inter.
- Layout: generous whitespace, restrained borders, low visual noise, no decorative gradients.

Operational status must not rely on color alone. Pair every state with an icon, label, and explanatory text. Red is reserved for true blockers; amber is used for warnings; neutral brown/gray supports normal states. All text and controls must meet WCAG 2.2 AA contrast and keyboard requirements.

Primary navigation:

- Dashboard
- Inventory
- Products & Recipes
- Orders
- Production
- Purchasing
- Forecast
- Sync & Settings

The default dashboard should answer questions rather than show decorative metrics. Its priority order is order blockers, 86'd products, production capacity, reorder actions, forecast risks, inbound materials, and synchronization health.

## 5. Delivery architecture

### 5.1 Shared monorepo

Use a TypeScript-first pnpm workspace so the web and desktop applications share behavior rather than copying it.

- `apps/web`: React/Vite installable PWA.
- `apps/api`: Fastify HTTP API, OAuth callbacks, webhook endpoints, and synchronization command handler.
- `apps/worker`: scheduled forecasts, Square reconciliation, Sheets mirroring, token refresh, email digests, and retry jobs.
- `apps/desktop`: Phase 2 Tauri 2 shell and Mac-specific capabilities.
- `packages/domain`: pure inventory, recipe, capacity, allocation, forecasting, reorder, and order-readiness rules.
- `packages/contracts`: versioned command, event, API, and integration schemas.
- `packages/application`: use cases and repository interfaces.
- `packages/sync`: shared outbox/inbox protocol, conflict types, cursors, and reconciliation rules.
- `packages/ui`: brand tokens, accessible components, layouts, and feature screens.
- `packages/persistence-contracts`: storage interfaces implemented by PostgreSQL, IndexedDB, and SQLite adapters.
- `packages/test-kit`: deterministic clocks, fixtures, builders, and contract-test suites.
- `packages/config`: TypeScript, linting, formatting, and test configuration.

### 5.2 Phase 1 runtime

- Node.js 24 LTS.
- React 19 with Vite 7 for the client.
- Fastify 5 for the API and worker processes.
- PostgreSQL 17 or newer as the authoritative store.
- Drizzle ORM and checked-in SQL migrations.
- Dexie over IndexedDB for the web app's cached read model, pending command outbox, and synchronization metadata.
- Workbox for application-shell caching and replay assistance; the application still owns command idempotency and conflict behavior.
- Zod schemas in `packages/contracts` for runtime validation at every process boundary.
- Decimal arithmetic for mass, cost, and unit conversion; inventory math must not use binary floating-point numbers.
- A PostgreSQL-backed jobs table with leases and retry metadata; do not introduce Redis for this single-operator system.
- Supabase-managed PostgreSQL as the initial hosted database, using a normal PostgreSQL connection from the API/worker and direct connections for migrations and backup/restore. Keep standard SQL and containerized services so the database can move to another managed PostgreSQL provider.
- Supabase Auth email magic link/OTP as the initial identity provider. The API verifies the callback, creates its own opaque server-side session, and gives the browser only a secure HTTP-only session cookie.
- Containerized API/worker deployment so the hosting provider can change without application rewrites.

Node's official release guidance says production applications should use an LTS line; Node 24 is LTS as of this design date. See [Node.js releases](https://nodejs.org/en/about/previous-releases).

### 5.3 Phase 2 runtime

- Tauri 2 Mac desktop shell using the shared React UI.
- SQLite via the official Tauri SQL plugin for a durable local read model and outbox.
- The same versioned command/event synchronization protocol used by the PWA.
- Tauri updater and signed/notarized Mac releases.
- Local encrypted backup export and restore using an application-defined archive format.

The official Tauri SQL plugin supports SQLite and transactional migrations. See [Tauri SQL](https://v2.tauri.app/plugin/sql/).

### 5.4 Authority rule

PostgreSQL is the authoritative cloud ledger. IndexedDB and SQLite are durable local projections plus pending-command outboxes. No client submits an absolute count as a silent last-write-wins update. Every change is a command with:

- `commandId` UUID used as an idempotency key.
- `organizationId` and `actorId`.
- `deviceId`.
- `occurredAtLocal` and `queuedAt`.
- `baseRevision` for optimistic concurrency.
- A typed payload such as receive stock, record batch, reserve order, or adjust count.

The API accepts a command once, validates it against current state, commits resulting ledger events in one database transaction, and returns the new server revision. Duplicate command IDs return the original result.

## 6. Domain model

### 6.1 Organization and users

The system starts with one organization and one Owner/Admin. Store roles as `OWNER_ADMIN`, `PRODUCTION`, and `FULFILLMENT`. Permission checks exist in the API from the first release, although the owner holds every permission initially.

### 6.2 Inventory items

Every physical item has:

- Stable internal ID and human-readable SKU.
- Name, description, active state, and optional photo.
- Category: raw material, component, finished good, packing material, shipping material, or miscellaneous.
- Dependency class: production-critical, fulfillment-critical, or advisory.
- Base unit and display precision.
- Purchase unit, package conversion, pack size, minimum order quantity, and reorder multiple.
- On-hand, reserved, incoming, protected, and available quantities derived from ledger/projection data.
- Lot-control and FIFO settings.
- Reorder policy and forecast coverage target.
- Preferred and alternate vendors.
- Optional Square catalog variation mapping.
- Audit timestamps and revision.

### 6.3 Units

Mass base units are stored in grams internally, while the UI can display ounces or pounds. Countable items use integer eaches. Volume is supported for future formulations but is not implicitly converted to mass. Every conversion is explicit and versioned.

Receiving one 10 lb wax case adds exactly 4,535.9237 grams before UI rounding. Recipe and availability comparisons use stored decimal values, never display-rounded values.

### 6.4 Current candle recipe

Seed one reusable 17 oz fill recipe template with zero process loss until the owner enables and configures it:

- Golden Brands 464 soy wax: 15.7 oz per candle.
- Fragrance oil: 1.3 oz per candle, overridden by scent/product.
- Vessel: 1 each.
- Lid: 1 each.
- Circular label: 1 each.
- Rectangular scent label: 1 each, overridden by scent/product.
- Wooden wick: 1 each.

The template total is 17 oz of wax plus fragrance. Future candle sizes create new recipe-template versions. Editing an active recipe creates a new version; historical batches retain the recipe version used.

### 6.5 Process-loss policy

Each recipe component supports `NONE`, `PERCENT_PER_UNIT`, `FIXED_PER_BATCH`, or `BOTH`. Wax-leftover and fragrance-spillage toggles are exposed separately. Required quantity for `n` finished units is:

`required(n) = n × perUnit × (1 + percentageLoss) + ceil(n ÷ batchSize) × fixedBatchLoss`

The calculation engine finds the largest whole `n` that every production-critical component can support. Because fixed batch loss makes direct division inaccurate, use a monotonic integer search rather than a single division formula.

### 6.6 Lots and FIFO

Lot-controlled receipts can include supplier lot number, internal lot code, received date, best-by date, unit cost, and notes. Production consumption proposes FIFO lots by received date, then best-by date, while permitting an audited manual override. Finished production batches record source lots for traceability.

## 7. Inventory ledger and projections

Inventory quantities derive from immutable ledger entries. Supported causes include:

- Receipt
- Physical-count adjustment
- Damage or spoilage
- Production allocation
- Production consumption
- Production output
- Order reservation
- Reservation release
- Fulfillment consumption
- Customer return
- Vendor return
- Process loss
- Synchronization correction
- Administrative reversal

Corrections create compensating entries. Posted ledger entries are not edited or deleted.

For an item at a point in time:

`available = max(0, onHand - activeReservations - enabledProtectedStock)`

Incoming purchase orders are shown separately and are included only in future-dated feasibility calculations when their expected arrival is on or before the required date. They never inflate current availability.

## 8. Capacity and production planning

### 8.1 Per-product capacity

For one product/size variant, calculate:

- Theoretical capacity: ignores protected stock and optional process loss.
- Adjusted capacity: includes every enabled protection/loss rule.
- Finished goods available now.
- Additional units makeable from raw materials.
- Total potential units: finished goods plus adjusted makeable units.
- Limiting component and quantity shortfall to make one additional unit.

Per-product capacity is explicitly labeled hypothetical because the same shared wax or vessels appear in multiple product calculations.

### 8.2 Allocated plan

An allocated production plan reserves shared materials against selected product quantities. Default priority is:

1. Paid order due date.
2. Existing order production shortfall.
3. Owner-assigned priority.
4. Forecast stockout date.
5. Recent sales velocity.
6. Stable SKU ordering as a deterministic tie-breaker.

The engine applies the same capacity rules sequentially and returns planned, partially planned, and blocked quantities plus exact blockers. The owner can reorder priorities and run a dry-run before committing. Committing a plan creates material reservations; completing a batch consumes materials and creates finished goods.

## 9. Orders and readiness

Square paid orders are reserved immediately. Canceled or fully refunded orders release their reservations. Fulfillment consumes finished goods and the applicable packing/shipping recipe. Manual orders use the same lifecycle.

For each order line:

1. Allocate current finished goods.
2. Calculate the remaining production requirement.
3. Test the remaining requirement against production-critical ingredients.
4. Evaluate packing rules separately by order quantity, channel, and fulfillment type.
5. Surface advisory supply warnings without blocking either stage.

Order-level statuses are:

- Ready from finished goods.
- Makeable before due date.
- Partially makeable.
- Blocked by production material.
- Production-ready but blocked by fulfillment material.
- Ready with advisory warnings.
- Stale/offline assessment.

Every blocked state lists item, required quantity, available quantity, incoming quantity, shortage, preferred vendor, and earliest expected resolution.

## 10. Packing and shipping rules

Packing recipes are configurable separately from candle recipes. A rule can match fulfillment type, sales channel, candle-count range, and product family. It can require boxes, dividers, filler, inserts, tape, or other materials.

Production capacity never depends on fulfillment or advisory materials. Fulfillment-critical shortages block only shipping readiness. Advisory shortages appear in warnings and purchase recommendations but do not block.

## 11. Square integration

Square cannot track manufacturing subcomponents or product bundling, so ingredient/BOM truth remains inside this app. The official Square Inventory documentation explicitly notes this limitation: [Square Inventory API](https://developer.squareup.com/docs/inventory-api/what-it-does).

Use Square OAuth code flow through the server. Store encrypted access/refresh tokens only on the server. Request least-privilege scopes initially:

- `MERCHANT_PROFILE_READ`
- `ITEMS_READ`
- `INVENTORY_READ`
- `ORDERS_READ`

Request `INVENTORY_WRITE` and `ITEMS_WRITE` only when the owner enables Square stock/availability writeback. Square documents its OAuth flows and token behavior at [Square OAuth](https://developer.squareup.com/docs/oauth-api/overview).

Subscribe to catalog, inventory, order-created, order-updated, fulfillment-updated, and authorization-revoked events needed by the enabled feature set. Validate every webhook from the raw body, configured URL, signature key, and `x-square-hmacsha256-signature` using constant-time verification, as required by [Square webhook validation](https://developer.squareup.com/docs/webhooks/step3validate).

Webhook processing rules:

- Persist the event ID before handling it.
- Acknowledge validated events promptly.
- Process asynchronously and idempotently.
- Fetch current Square state rather than assuming webhook payload completeness.
- Maintain per-resource cursors/revisions.
- Run scheduled reconciliation to recover missed webhooks.

Square order events reserve and release local finished goods. Square's order and fulfillment concepts are documented in the [Orders API](https://developer.squareup.com/docs/orders-api/what-it-does).

86/un-86 behavior:

- Default mode: internal alert plus a proposed Square change requiring owner approval.
- Optional automatic mode: enabled globally and overridable per product.
- Automatic changes require recent successful Square sync, non-stale local data, and a second capacity calculation inside the write transaction.
- Every write records before/after state, reason, Square response, actor/mode, and rollback recommendation.
- Never auto-un-86 solely because an inbound purchase order exists.

## 12. Google Sheets mirror and import

The app database remains authoritative. A worker produces a versioned spreadsheet snapshot with these tabs:

- Dashboard
- Inventory
- Finished Goods
- Capacity
- Orders
- Purchase Recommendations
- Lots
- Forecast
- Sync Log
- Approved Adjustments

Every exported tab includes snapshot ID and generated-at timestamp. Data tabs are protected where the Google account permits. Use atomic batch updates and exponential backoff within published Sheets quotas; Google documents atomic batch behavior and current quotas at [Sheets usage limits](https://developers.google.com/workspace/sheets/api/limits) and [batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate).

`Approved Adjustments` is the only import surface. Each row requires:

- External row ID.
- Inventory item SKU.
- Adjustment direction and quantity.
- Unit.
- Reason code.
- Effective date.
- Human note.
- Import status and validation message written by the app.

Imports follow preview, validation, explicit confirmation, ledger posting, and result writeback. Duplicate row IDs are idempotent. Invalid units, unknown SKUs, negative outcomes, stale snapshots, or conflicting revisions block the row without affecting other rows.

## 13. Offline behavior and synchronization

The PWA caches the application shell, current read models, recipes, orders needed for work, vendor references, and synchronization metadata. It permits these offline commands:

- Receive inventory.
- Record a physical-count adjustment.
- Record production consumption/output.
- Record damage or process loss.
- Create/update a manual order.
- Draft a production plan.

Square refresh, Sheets export/import, email sending, OAuth connection, and Square writeback require connectivity.

The interface always displays:

- Online/offline state.
- Last authoritative server synchronization timestamp.
- Number of queued local commands.
- Whether displayed calculations include un-synchronized local commands.
- A stale-data warning when the configured freshness threshold is exceeded.

Reconnection sequence:

1. Authenticate and fetch current server revision.
2. Upload pending commands in local order.
3. Accept duplicates idempotently.
4. Apply commands whose preconditions remain valid.
5. Return structured conflicts for commands whose base data changed.
6. Refresh the local projection.
7. Require owner resolution for conflicts; never discard a pending command silently.

Conflict choices are keep server state, apply a compensating local adjustment, or edit and resubmit the command. The UI shows the before, local intent, server change, and resulting quantity for each option.

Workbox Background Sync can assist replay, but browser support is not treated as sufficient durability; the explicit IndexedDB outbox is authoritative on the PWA. See [Workbox Background Sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync).

## 14. Forecasting

Forecasts are calculated per finished-good variant for 30, 60, and 90 days. Version one uses an explainable weighted baseline:

- 50% recent 30-day daily velocity.
- 30% recent 90-day daily velocity.
- 20% same-period prior-year daily velocity when at least one year of data exists.
- Missing windows redistribute their weight proportionally across available windows.

Apply a monthly seasonal index only after twelve complete months of usable sales. Clamp the initial index to 0.5–2.0 to prevent sparse history from creating extreme recommendations. Add paid open orders and manual demand events such as markets, wholesale commitments, and promotions. Manual events show separately from statistical demand.

Forecast output includes projected demand, current finished goods, makeable quantity, projected shortfall date, ingredients causing the shortfall, data window used, seasonal factor, and manual adjustments.

The owner can override a forecast quantity with an expiration date and written reason. The system preserves both computed and overridden values.

## 15. Reordering and vendors

Vendor records include contact/display name, preferred status, product URL, vendor SKU, purchase unit, pack conversion, current price, price history, lead time, minimum order quantity, reorder multiple, shipping estimate, and notes.

Default reorder point:

`leadTimeDemand + safetyDaysDemand + protectedStock`

Recommended purchase quantity:

`targetCoverageDemand - available - usableIncoming`

Round the result up to the vendor's pack size, reorder multiple, and minimum order quantity. Never recommend a negative quantity. The recommendation includes order-by date, expected stockout date, preferred vendor, alternates, estimated cost, direct product link, inputs, and reason.

Recommendations group by vendor. The user can mark a recommendation ordered, record expected arrival and actual cost, and later receive it into lots. This creates an expected inbound record; it does not place an external order.

## 16. Alerts and digests

In-app alerts include:

- Production material below reorder point.
- Fulfillment material shortage.
- Advisory material shortage.
- Product 86'd or at risk.
- Paid order blocked or partially makeable.
- Forecasted stockout within lead time.
- Incoming purchase overdue.
- Lot near best-by date.
- Square/Sheets/email synchronization failure.
- OAuth authorization revoked or token refresh failed.
- Offline data stale or conflict unresolved.

Email digest frequencies are disabled, daily, weekly, or monthly. Digest sections include immediate actions, paid-order risks, 86'd products, purchase recommendations, expected receipts, expiring lots, sync health, and 30/60/90-day forecasts. Immediate critical email alerts are independently configurable.

## 17. Security, privacy, and auditability

- Use server-side sessions with secure, HTTP-only, same-site cookies for the web app.
- Use Supabase Auth email magic link/OTP for identity and retain application sessions/roles in the app database. Configure production custom SMTP rather than Supabase's restricted trial mail service.
- Keep Square and Google refresh tokens encrypted at rest and unavailable to browser/desktop JavaScript.
- Use CSRF protection for state-changing browser requests.
- Rate-limit authentication, webhook, import, and mutation endpoints.
- Validate every request with shared schemas.
- Encrypt transport with HTTPS and database backups with provider-managed encryption.
- Minimize stored customer data. Order sync retains operational identifiers, quantities, due/fulfillment status, and only the shipping fields required to assess fulfillment.
- Do not include customer PII in Google Sheets by default.
- Maintain an append-only audit trail for authentication, inventory commands, imports, integration writes, settings changes, conflicts, and role changes.
- Redact secrets and customer details from logs.

## 18. Reliability and error handling

- Every external write uses an idempotency key when supported.
- External failures enter a retryable job with exponential backoff, bounded attempts, and a visible dead-letter state.
- Integration health records last success, last attempt, cursor, error category, retry time, and operator action.
- Square webhook receipt and processing are separate transactions.
- Sheets snapshots are generated from one database snapshot and published only after every required tab succeeds.
- Production completion is one database transaction: validate reservation, consume lots/materials, record loss, create finished goods, and close the batch.
- Purchase receipt is one transaction: create lot(s), post receipt, reduce expected inbound quantity, update cost history, and refresh projections.
- Database backups are tested through a documented restore rehearsal before production launch.

## 19. Testing strategy

### 19.1 Domain tests

Use deterministic unit/property tests for conversions, decimal precision, process loss, protected stock, lot selection, capacity, allocation, order readiness, forecasting, and reorder rounding. Include the exact current candle recipe as a permanent fixture.

Critical invariants:

- Available inventory cannot be negative in a committed projection.
- A component cannot be allocated twice.
- Process loss never increases capacity.
- Protected stock never increases capacity.
- A duplicated command never posts a second ledger entry.
- A canceled order releases exactly its active reservation.
- Advisory items never block production or fulfillment.
- Fulfillment-critical items never reduce candle-making capacity.
- Display rounding never changes ledger totals.

### 19.2 Contract tests

Run the same repository and sync contract suite against PostgreSQL, IndexedDB, and Phase 2 SQLite adapters. Run API schema compatibility tests against every versioned command/event fixture.

### 19.3 Integration tests

- PostgreSQL migrations up/down in disposable databases.
- Square Sandbox OAuth, catalog import, orders, webhooks, reconciliation, and approved availability writeback.
- Google Sheets snapshot, protected structure, quota retry, import preview, idempotent posting, and partial invalid-row reporting.
- Email digest rendering and deduplication through a fake provider.
- Worker lease, retry, and dead-letter behavior.

### 19.4 End-to-end tests

Test online and offline journeys in Chromium and WebKit:

- Onboard current recipe and receive materials.
- Calculate limiting ingredients.
- Import a Square paid order and reserve finished goods.
- Produce the shortfall and verify shipping readiness separately.
- Go offline, record a receipt and batch, reconnect, and reconcile.
- Create a deliberate conflict and resolve it without data loss.
- Approve a Square 86 action and verify audit history.
- Publish and validate a Sheets mirror.
- Generate a purchase recommendation and mark it ordered/received.

### 19.5 Desktop parity tests

Phase 2 reuses the domain, contract, and UI test suites. Add SQLite adapter contracts, macOS packaging smoke tests, updater signature tests, offline restart durability, and PWA-versus-desktop golden scenario comparison.

## 20. Operational acceptance criteria

The system is ready for live use only when all conditions are true:

- The current 17 oz recipe calculates exact theoretical and adjusted capacity from seeded inventory.
- Shared-material allocation never promises more than physical inventory supports.
- A paid Square order is reflected within the webhook target window and recovered by reconciliation if the webhook is suppressed.
- Order readiness distinguishes finished stock, makeable shortfall, fulfillment blockers, and advisory warnings.
- Offline commands survive browser restart and reconcile exactly once.
- Every offline screen shows its authoritative-data timestamp.
- Sheets mirrors are labeled snapshots and cannot silently overwrite the app ledger.
- Square writebacks remain manual by default.
- Vendor recommendations honor lead time, pack size, minimum order quantity, and incoming orders.
- All critical invariants, adapter contracts, Square Sandbox tests, offline end-to-end tests, accessibility scans, and restore rehearsal pass.
- The codebase builds the shared UI/domain packages without importing browser-only APIs, proving that the desktop shell can consume them.

## 21. Phase boundaries

### Phase 1: usable now

Deliver the web/PWA, authoritative API/database, current recipe onboarding, inventory ledger, capacity/allocation, finished goods, Square read integration, order readiness, production batches, purchasing, Google Sheets mirror/import, forecasting, alerts/digests, offline queue, reconciliation, audit, and optional approved Square writeback.

### Phase 2: native Mac application

Add the Tauri shell, SQLite local projection/outbox, secure native token/session handoff, local backup archive, updater, signing/notarization, and macOS packaging. Do not fork domain rules or feature screens. Any behavior difference requires an explicit platform capability interface and parity test.

## 22. Implementation guardrails for Claude Code

- No task may mix domain-rule invention with UI polish.
- Every domain behavior starts with a failing test.
- Every inventory mutation is a command that produces ledger entries.
- Never add a direct `setQuantity` path outside controlled physical-count reconciliation.
- Never place Square/Google credentials in client bundles or local storage.
- Never accept a Square webhook before signature validation.
- Never use JavaScript floating-point arithmetic for mass, cost, or conversion.
- Never treat a cached offline calculation as live without its timestamp and stale badge.
- Never add desktop-specific conditionals to domain packages.
- Do not call the project complete because screens render; completion requires the acceptance suite and restore rehearsal.

## 23. Design self-review

- Placeholder scan: no unresolved implementation placeholders remain.
- Consistency: the web and desktop phases share one authority model and synchronization protocol.
- Scope: Phase 1 is a complete usable product; Phase 2 is independently testable native delivery work.
- Ambiguity resolution: Google Sheets is a mirror/import surface, Square writeback is manual by default, and only production-critical items affect candle capacity.
- Known operational values such as vendor pack sizes, loss percentages, protected quantities, packing recipes, lead times, and digest frequency are intentionally user-configurable onboarding data, not missing software requirements.
