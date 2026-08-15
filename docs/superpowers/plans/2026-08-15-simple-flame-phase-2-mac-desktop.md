# Simple Flame Phase 2 Mac Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a signed, notarized native Mac application with durable SQLite offline storage while preserving exact behavioral parity with the Phase 1 web/PWA and cloud system.

**Architecture:** Tauri 2 wraps the existing shared React UI and provides narrowly scoped native capabilities. SQLite implements the persistence/outbox contracts already exercised by PostgreSQL and IndexedDB. The desktop app authenticates through a PKCE device flow, stores refresh material in Tauri Stronghold, and synchronizes the same V1 commands/events with the existing cloud API.

**Tech Stack:** Existing Phase 1 monorepo and Node.js 24 toolchain, Tauri 2, Rust toolchain supported by Tauri 2 (minimum Rust 1.77.2), SQLite through `@tauri-apps/plugin-sql`, Tauri Stronghold, deep-link, single-instance, updater, Vitest, Playwright/Webdriver smoke tests, macOS signing/notarization tools.

## Global Constraints

- Phase 1 must have passed `pnpm verify:release` before this plan begins.
- The desktop app must reuse `@simple-flame/domain`, `contracts`, `application`, `sync`, `persistence-contracts`, `ui`, and `test-kit` without copying files.
- PostgreSQL remains authoritative; SQLite is a local projection plus command outbox.
- Store decimal quantities and money in SQLite as canonical text, not binary floating-point columns.
- Do not expose Square or Google tokens to the desktop app; those integrations remain server-side.
- Store the desktop refresh credential only in Stronghold; never localStorage, IndexedDB, plain SQLite, logs, or crash reports.
- Every deep link must validate scheme, state, PKCE verifier, expiration, and one-time authorization code.
- Support macOS 12 or newer on Apple Silicon and Intel during the initial desktop release.
- Updates must be signed, rollback-aware, and blocked while a local database migration or sync transaction is active.
- Every shared golden scenario must produce the same quantities, readiness states, conflicts, and forecast outputs on PWA and desktop.

---

## Planned Phase 2 files

- `apps/desktop/src-tauri/`: Rust entry, plugins, capabilities, migrations, bundle metadata, entitlements, updater configuration.
- `apps/desktop/src/`: desktop bootstrap, platform capability adapter, local store composition, authentication bridge, update and backup UI glue.
- `packages/persistence-sqlite/`: SQLite read model, outbox, sync metadata, migrations, and adapter contract suite.
- `packages/platform-contracts/`: narrow interfaces for secure secrets, backup files, update checks, connectivity, and app metadata.
- `packages/test-kit/src/golden/`: cross-platform scenario inputs and expected snapshots.
- `docs/operations/desktop-*.md`: development, signing, notarization, update, backup, and recovery procedures.

### Task 1: Scaffold Tauri and introduce explicit platform capability ports

**Files:**
- Modify: `pnpm-workspace.yaml`
- Replace: `apps/desktop/README.md`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/desktop-composition.ts`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `packages/platform-contracts/src/index.ts`
- Modify: `scripts/check-boundaries.mjs`
- Test: `packages/platform-contracts/src/platform-contracts.test.ts`
- Test: `scripts/check-boundaries.test.mjs`

**Interfaces:**
- Produces `SecureSecretStore`, `BackupFileGateway`, `UpdateGateway`, `ConnectivityGateway`, and `AppMetadataGateway`.
- The shared UI/application layers consume only these interfaces, never Tauri directly.

- [ ] **Step 1: Write failing boundary tests for Tauri imports**

```js
test("only apps/desktop may import Tauri packages", async () => {
  const violations = await findTauriImportViolations(process.cwd());
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: Run boundary tests and confirm missing desktop rules**

Run: `pnpm check:boundaries`
Expected: FAIL because the Phase 1 checker has no desktop-specific rule.

- [ ] **Step 3: Define capability interfaces and scaffold Tauri**

```ts
export interface SecureSecretStore {
  get(key: "desktopRefreshToken"): Promise<string | null>;
  set(key: "desktopRefreshToken", value: string): Promise<void>;
  remove(key: "desktopRefreshToken"): Promise<void>;
}

export interface BackupFileGateway {
  exportEncryptedArchive(input: BackupArchive): Promise<{ path: string }>;
  importEncryptedArchive(): Promise<BackupArchive | null>;
}
```

Configure bundle identifier `com.thesimpleflame.inventory`, product name `Simple Flame Inventory`, macOS minimum `12.0`, CSP, no arbitrary shell capability, and only explicitly required Tauri plugin permissions.

- [ ] **Step 4: Build the empty desktop shell and prove shared packages compile**

Run: `pnpm --filter @simple-flame/desktop tauri build --debug --bundles app && pnpm check:boundaries`
Expected: PASS; the debug `.app` opens the shared app shell with fake services.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop packages/platform-contracts scripts pnpm-workspace.yaml
git commit -m "feat: scaffold Mac desktop shell and platform ports"
```

### Task 2: Implement the SQLite projection and outbox adapter

**Files:**
- Create: `packages/persistence-sqlite/package.json`
- Create: `packages/persistence-sqlite/src/database.ts`
- Create: `packages/persistence-sqlite/src/read-model.ts`
- Create: `packages/persistence-sqlite/src/outbox.ts`
- Create: `packages/persistence-sqlite/src/sync-metadata.ts`
- Create: `apps/desktop/src-tauri/migrations/0001_local_projection.sql`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `packages/persistence-sqlite/src/outbox.contract.test.ts`
- Test: `packages/persistence-sqlite/src/read-model.contract.test.ts`
- Test: `packages/persistence-sqlite/src/migration.test.ts`

**Interfaces:**
- Implements the same `LocalStore`, `OutboxRepository`, and read-model contracts as IndexedDB.

- [ ] **Step 1: Run existing adapter contracts against a missing SQLite adapter**

```ts
runOutboxContract("sqlite", async () => openSqliteOutbox(tempDatabasePath()));
runReadModelContract("sqlite", async () => openSqliteReadModel(tempDatabasePath()));
```

Run: `pnpm --filter @simple-flame/persistence-sqlite test`
Expected: FAIL because adapter functions are missing.

- [ ] **Step 2: Create transactional, versioned SQLite migrations**

```sql
CREATE TABLE local_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE command_outbox (
  command_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','SENDING','ACCEPTED','CONFLICT','RETRYABLE')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

Store all decimal amounts and revisions as canonical text. Use SQLite transactions for projection replacement and outbox state changes. Apply Tauri SQL migrations transactionally at startup.

- [ ] **Step 3: Implement adapters without desktop UI knowledge**

```ts
export async function openSqliteLocalStore(database: SqlDatabase): Promise<LocalStore> {
  return {
    outbox: new SqliteOutbox(database),
    readModel: new SqliteReadModel(database),
    syncMetadata: new SqliteSyncMetadata(database),
  };
}
```

- [ ] **Step 4: Run contract, migration-upgrade, and abrupt-restart tests**

Run: `pnpm --filter @simple-flame/persistence-sqlite test`
Expected: PASS for enqueue, duplicate ID, ordered replay, conflict persistence, accepted cleanup, projection transaction rollback, v1-to-current migration, and reopen after forced process exit.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence-sqlite apps/desktop/src-tauri
git commit -m "feat: add durable SQLite desktop storage"
```

### Task 3: Reuse the sync engine and prove offline parity

**Files:**
- Create: `apps/desktop/src/sync/desktop-sync-controller.ts`
- Create: `apps/desktop/src/sync/connectivity-adapter.ts`
- Create: `packages/test-kit/src/golden/offline-operations.ts`
- Modify: `packages/sync/src/sync-machine.test.ts`
- Test: `apps/desktop/src/sync/desktop-sync-controller.test.ts`
- Test: `packages/test-kit/src/golden/offline-parity.test.ts`

**Interfaces:**
- Consumes the Phase 1 `SyncMachine` unchanged.
- Produces the same freshness, queue-count, and conflict view models as the PWA.

- [ ] **Step 1: Write a golden PWA/SQLite parity scenario**

```ts
it.each([indexedDbHarness, sqliteHarness])("replays receipt and production exactly once", async (harness) => {
  const result = await runOfflineReceiptAndBatchScenario(harness);
  expect(result).toEqual(goldenOfflineReceiptAndBatchSnapshot);
});
```

- [ ] **Step 2: Run parity test and confirm SQLite composition fails**

Run: `pnpm test --filter offline-parity`
Expected: FAIL because the desktop controller is absent.

- [ ] **Step 3: Implement desktop connectivity and sync composition**

```ts
export function createDesktopSyncController(deps: {
  localStore: LocalStore;
  api: SyncApi;
  connectivity: ConnectivityGateway;
  clock: Clock;
}): SyncController {
  return new SyncController(new SyncMachine(deps), deps.localStore);
}
```

Trigger sync on launch, login, connectivity restoration, manual refresh, and a bounded interval. Suspend during database migration, archive restore, and app update.

- [ ] **Step 4: Run long-offline, restart, duplicate, and conflict parity tests**

Run: `pnpm test --filter offline-parity && pnpm --filter @simple-flame/desktop test -- sync`
Expected: PASS with byte-equivalent command payloads and equal final projections for IndexedDB and SQLite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop packages/test-kit packages/sync
git commit -m "feat: reuse cloud sync in the Mac desktop app"
```

### Task 4: Add PKCE desktop login, deep links, and Stronghold secrets

**Files:**
- Create: `apps/api/src/routes/desktop-auth.ts`
- Create: `apps/desktop/src/auth/desktop-auth.ts`
- Create: `apps/desktop/src/auth/deep-link-handler.ts`
- Create: `apps/desktop/src/platform/stronghold-secret-store.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Test: `apps/api/src/routes/desktop-auth.test.ts`
- Test: `apps/desktop/src/auth/deep-link-handler.test.ts`

**Interfaces:**
- Produces one-time authorization code exchange with PKCE and a desktop refresh credential stored only in Stronghold.

- [ ] **Step 1: Write forged-link, replay, state, and verifier tests**

```ts
it("rejects a valid-looking deep link with the wrong state", async () => {
  await expect(handler.handle("simpleflame-inventory://auth/callback?code=abc&state=wrong")).rejects.toThrow("state mismatch");
  expect(await secrets.get("desktopRefreshToken")).toBeNull();
});
```

- [ ] **Step 2: Confirm auth tests fail**

Run: `pnpm --filter @simple-flame/api test -- desktop-auth && pnpm --filter @simple-flame/desktop test -- auth`
Expected: FAIL.

- [ ] **Step 3: Implement PKCE login through the system browser**

Generate verifier/challenge/state in the desktop app, open the server authorization URL, validate the returned custom-scheme URL, exchange the one-time code, and rotate refresh credentials after use. The server binds codes to device ID, user, challenge, expiration, and single-use status.

- [ ] **Step 4: Configure single-instance and deep-link plugins first in Tauri startup**

Accept only `simpleflame-inventory://auth/callback`, normalize exactly one callback, reject extra parameters outside the schema, and never log the full URL. Initialize Stronghold with an application salt path and no hardcoded password.

- [ ] **Step 5: Run security and restart tests**

Run: `pnpm --filter @simple-flame/api test -- desktop-auth && pnpm --filter @simple-flame/desktop test -- auth`
Expected: PASS for login, restart, credential rotation, logout wipe, replay, expired code, forged scheme, duplicate app instance, and revoked server session.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/desktop
git commit -m "feat: secure Mac desktop authentication"
```

### Task 5: Compose the shared UI with native platform capabilities

**Files:**
- Create: `apps/desktop/src/platform/desktop-platform.ts`
- Create: `apps/desktop/src/platform/desktop-update-gateway.ts`
- Create: `apps/desktop/src/routes/DesktopSettings.tsx`
- Modify: `packages/ui/src/layout/AppShell.tsx`
- Modify: `apps/desktop/src/desktop-composition.ts`
- Test: `apps/desktop/src/desktop-composition.test.tsx`
- Test: `packages/test-kit/src/golden/ui-parity.test.tsx`

**Interfaces:**
- Consumes the existing shared feature views.
- Adds only desktop settings for local storage path, backup, update, version, and sync diagnostics.

- [ ] **Step 1: Write route and behavior parity tests**

```tsx
it.each([webUiHarness, desktopUiHarness])("shows stale timestamp and two pending commands", async (harness) => {
  const screen = await harness.render(staleOfflineViewModel({ pending: 2 }));
  expect(screen.getByText(/Data accurate as of/)).toBeVisible();
  expect(screen.getByText(/2 changes waiting to sync/)).toBeVisible();
});
```

- [ ] **Step 2: Confirm desktop composition fails**

Run: `pnpm test --filter ui-parity`
Expected: FAIL because desktop service composition is incomplete.

- [ ] **Step 3: Bind shared screens to SQLite and native capability adapters**

```ts
export const desktopServices: AppServices = {
  inventory: createInventoryService(sqliteStore, syncController),
  production: createProductionService(sqliteStore, syncController),
  orders: createOrderService(sqliteStore, syncController),
  platform: createDesktopPlatform(),
};
```

Do not add `isDesktop` branches inside domain/use-case packages. Limit platform differences to capability availability and desktop-only settings routes.

- [ ] **Step 4: Run shared feature, keyboard, accessibility, and UI parity tests**

Run: `pnpm --filter @simple-flame/ui test && pnpm --filter @simple-flame/desktop test && pnpm test --filter ui-parity`
Expected: PASS with matching operational copy and states.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop packages/ui packages/test-kit
git commit -m "feat: compose shared inventory UI for macOS"
```

### Task 6: Add encrypted local backup export and controlled restore

**Files:**
- Create: `apps/desktop/src-tauri/src/backup.rs`
- Create: `apps/desktop/src/platform/tauri-backup-gateway.ts`
- Create: `packages/contracts/src/backup-archive.ts`
- Create: `apps/desktop/src/routes/BackupRestore.tsx`
- Create: `docs/operations/desktop-backup-restore.md`
- Test: `apps/desktop/src/platform/tauri-backup-gateway.test.ts`
- Test: `apps/desktop/src-tauri/tests/backup_roundtrip.rs`

**Interfaces:**
- Produces a versioned encrypted archive containing SQLite projection, pending outbox commands, sync metadata, manifest hashes, and app/schema versions.

- [ ] **Step 1: Write round-trip, corruption, wrong-password, and newer-schema tests**

```rust
#[test]
fn rejects_archive_with_changed_payload_hash() {
    let archive = tamper(export_fixture_archive());
    assert!(matches!(restore_archive(archive), Err(RestoreError::HashMismatch)));
}
```

- [ ] **Step 2: Confirm native and TypeScript tests fail**

Run: `pnpm --filter @simple-flame/desktop test -- backup && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml backup`
Expected: FAIL.

- [ ] **Step 3: Implement export with application-level encryption and manifest hashes**

Use a user-supplied backup passphrase with a memory-hard KDF, authenticated encryption, random salt/nonce, and no passphrase persistence. Flush SQLite WAL and copy through SQLite backup semantics rather than raw live-file copying.

- [ ] **Step 4: Implement restore as validate-preview-confirm-replace**

Validate archive version, hashes, encryption, organization identity, schema compatibility, and command counts before showing a preview. Require explicit confirmation, back up current data automatically, restore atomically, run migrations, reopen the database, and sync only after successful validation.

- [ ] **Step 5: Run backup/restore tests and manual Mac file-dialog smoke test**

Run: `pnpm --filter @simple-flame/desktop test -- backup && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS; canceled dialogs change nothing and failed restores leave current data intact.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop packages/contracts docs/operations/desktop-backup-restore.md
git commit -m "feat: add encrypted Mac desktop backups"
```

### Task 7: Implement signed updates, migration safety, and Mac distribution

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src/update/update-controller.ts`
- Create: `apps/desktop/src/routes/Updates.tsx`
- Create: `.github/workflows/desktop-release.yml`
- Create: `docs/operations/desktop-signing-notarization.md`
- Create: `docs/operations/desktop-update-recovery.md`
- Test: `apps/desktop/src/update/update-controller.test.ts`

**Interfaces:**
- Produces signed update checks and a notarized universal or paired architecture DMG release.

- [ ] **Step 1: Write update gating tests**

```ts
it("does not install while an outbox command is sending", async () => {
  await expect(controller.install(update, syncState({ sending: 1 }))).rejects.toThrow("Finish synchronization before updating");
});

it("rejects an unsigned update manifest", async () => {
  await expect(controller.check(unsignedManifest())).rejects.toThrow("invalid update signature");
});
```

- [ ] **Step 2: Confirm update tests fail**

Run: `pnpm --filter @simple-flame/desktop test -- update`
Expected: FAIL.

- [ ] **Step 3: Configure Tauri updater and safe install flow**

Use signed update metadata for `darwin-aarch64` and `darwin-x86_64`. Check when online, show version/notes, require user approval, verify no active migration/sync/restore, snapshot local data, download, verify signature, install, restart, migrate, and run a startup integrity check.

- [ ] **Step 4: Configure macOS signing and notarization workflow**

Build on macOS CI. Read certificates and App Store Connect credentials only from protected secrets. Produce DMG and updater artifacts, notarize, staple, verify with `codesign --verify --deep --strict` and `spctl --assess --type execute`, then publish signed update metadata.

- [ ] **Step 5: Run local unsigned debug and CI signed release-candidate checks**

Run locally: `pnpm --filter @simple-flame/desktop tauri build --debug --bundles app`
Run in protected Mac CI: `pnpm release:desktop:verify`
Expected: debug app passes local smoke; release candidate passes signature, notarization, updater, migration, and rollback-document checks.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop .github/workflows docs/operations
git commit -m "feat: sign notarize and update the Mac desktop app"
```

### Task 8: Complete desktop parity, durability, and release acceptance

**Files:**
- Create: `apps/desktop/e2e/golden-operations.spec.ts`
- Create: `apps/desktop/e2e/offline-restart.spec.ts`
- Create: `apps/desktop/e2e/auth-update-backup.spec.ts`
- Create: `docs/operations/desktop-launch-checklist.md`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm verify:desktop-release`, the mandatory Phase 2 release gate.

- [ ] **Step 1: Run the Phase 1 golden scenario against desktop composition**

```ts
test("desktop matches web for capacity, order readiness, and purchasing", async () => {
  const desktop = await runGoldenOperations(desktopHarness);
  const web = await loadApprovedWebGoldenSnapshot();
  expect(desktop.domainOutputs).toEqual(web.domainOutputs);
});
```

- [ ] **Step 2: Add power-loss and long-offline durability scenarios**

Force-close after enqueue, during retry, and after server acceptance but before local acknowledgment. Reopen and prove each command is accepted exactly once. Keep the Mac disconnected for seven simulated days and verify every screen shows stale timestamps while core local commands remain usable.

- [ ] **Step 3: Run the complete desktop release command**

Run: `pnpm verify:desktop-release`
Expected: PASS for Phase 1 regression, Rust tests, SQLite contracts/migrations, sync parity, UI parity, auth/deep-link security, backup/restore, updater gates, offline forced restart, Apple Silicon build, Intel build, accessibility, signing, notarization, and DMG install smoke.

- [ ] **Step 4: Perform mandatory two-stage review**

First review spec/Phase 1 parity and confirm no feature logic was forked. Second review Rust/Tauri capability scope, secret storage, deep-link validation, SQLite durability, archive cryptography, updater safety, signing, and operational recovery. Resolve every severity-1/2 finding and rerun `pnpm verify:desktop-release`.

- [ ] **Step 5: Execute owner acceptance on the actual Mac**

Install the notarized DMG, authenticate, synchronize current data, disconnect networking, record inventory and a production batch, restart the Mac app, reconnect, resolve a staged conflict, export/restore a backup in a test profile, and install a signed update. Record evidence in the launch checklist.

- [ ] **Step 6: Commit desktop release readiness**

```bash
git add .
git commit -m "chore: verify Mac desktop release readiness"
```

## Phase 2 self-review

- Spec coverage: desktop shell, SQLite, offline durability, secure auth, backup, updater, signing, notarization, and parity are covered.
- Placeholder scan: all platform choices and security boundaries are explicit.
- Type consistency: Phase 2 uses the exact V1 command/event and persistence contracts delivered by Phase 1.
- Bidirectional readiness: Phase 1 already exercises the shared rules and sync protocol; Phase 2 adds only adapters and native capabilities, and its golden tests protect Phase 1 behavior from regressions.
