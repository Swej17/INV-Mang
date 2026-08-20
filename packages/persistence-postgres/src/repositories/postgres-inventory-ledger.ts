import { randomUUID } from "node:crypto";

import { assertCanonicalDecimal, projectInventory, type LedgerEntryInput } from "@simple-flame/domain";
import {
  CommandIdCollisionError,
  InsufficientAvailableError,
  InvalidLedgerStateError,
  type AppendResult,
  type InventoryLedgerRepository,
  type LedgerEntryDraft,
  type LedgerEntryRecord,
  type ProjectionRecord,
} from "@simple-flame/persistence-contracts";
import type { Sql } from "postgres";

/**
 * PostgreSQL ledger adapter.
 *
 * Every append runs in one transaction that takes a row lock on the affected
 * item/location before reading availability. Without the lock two concurrent
 * reservations would each read the same "available" and each conclude they fit,
 * promising the same stock twice — the failure the contract suite exercises.
 */
export class PostgresInventoryLedgerRepository implements InventoryLedgerRepository {
  constructor(private readonly sql: Sql) {}

  async appendOnce(
    commandId: string,
    organizationId: string,
    entries: readonly LedgerEntryDraft[],
  ): Promise<AppendResult> {
    try {
      return await this.appendInTransaction(commandId, organizationId, entries);
    } catch (error) {
      if (!(error instanceof CommandIdCollisionError)) throw error;
      return this.resolveCommandIdConflict(commandId, organizationId, error);
    }
  }

  /**
   * Decide who owns a command id whose insert conflicted.
   *
   * SQLSTATE 23505 on a primary key can only fire once the competing
   * transaction has COMMITTED: an uncommitted duplicate insert blocks instead of
   * failing, and one that aborts leaves nothing to conflict with. So the winning
   * row is guaranteed to exist and be readable by the time we get here.
   *
   * It cannot be read on the transaction that hit the conflict — PostgreSQL has
   * aborted that one and rejects every further statement on it — so the recheck
   * runs as a fresh statement outside it.
   *
   * Finding the row under THIS organization means a retry overtook its own
   * in-flight original: that is an ordinary replay, and returning the stored
   * result keeps the exactly-once promise the whole design rests on. Finding
   * nothing means another organization owns the id, which stays a hard failure.
   */
  private async resolveCommandIdConflict(
    commandId: string,
    organizationId: string,
    collision: CommandIdCollisionError,
  ): Promise<AppendResult> {
    const settled = await this.sql`
      SELECT result_json FROM processed_commands
      WHERE command_id = ${commandId} AND organization_id = ${organizationId}
    `;
    if (settled.length === 0) throw collision;
    const original = settled[0]!["result_json"] as AppendResult;
    return { ...original, duplicate: true };
  }

  private async appendInTransaction(
    commandId: string,
    organizationId: string,
    entries: readonly LedgerEntryDraft[],
  ): Promise<AppendResult> {
    return this.sql.begin(async (tx) => {
      const replay = await this.findReplay(tx, commandId, organizationId);
      if (replay) return replay;

      await lockScopes(tx, organizationId, entries);
      const revision = await mintRevision(tx);
      const records = buildRecords(commandId, organizationId, revision, entries);

      // Validate the resulting state BEFORE writing anything. Postgres would
      // roll the transaction back anyway, but a typed error is more useful to
      // the sync layer than a constraint violation.
      await this.assertResultingStateIsValid(tx, organizationId, records);

      const result: AppendResult = { revision, duplicate: false, entries: records };
      await persist(tx, commandId, organizationId, result);
      return result;
    });
  }

  /**
   * Hand an order's outstanding reservations back, exactly once.
   *
   * The amounts are derived from the order's own history rather than supplied
   * by the caller: a client that has been offline cannot know how much of its
   * order the server still holds, and a caller-supplied figure that overshoots
   * would drive reserved negative — the failure InvalidLedgerStateError exists
   * to catch, reached here by design rather than by accident.
   */
  async releaseOrder(
    commandId: string,
    organizationId: string,
    orderId: string,
    locationId: string,
    reason: string,
  ): Promise<AppendResult> {
    try {
      return await this.releaseInTransaction(commandId, organizationId, orderId, locationId, reason);
    } catch (error) {
      if (!(error instanceof CommandIdCollisionError)) throw error;
      return this.resolveCommandIdConflict(commandId, organizationId, error);
    }
  }

  private async releaseInTransaction(
    commandId: string,
    organizationId: string,
    orderId: string,
    locationId: string,
    reason: string,
  ): Promise<AppendResult> {
    return this.sql.begin(async (tx) => {
      const replay = await this.findReplay(tx, commandId, organizationId);
      if (replay) return replay;

      // Read the outstanding reservations twice. The first read only says WHICH
      // item/location scopes this order touches — there is nothing to lock
      // before that is known — and the second, taken under those locks, says how
      // much each still holds. Without the second read a reservation committed
      // in between would be released at a stale figure.
      //
      // A scope that appears only in the second read is deliberately left for a
      // later release: it was reserved after this release began, and posting
      // against a scope whose lock we do not hold is exactly the double-write
      // the locks exist to prevent.
      const discovered = await outstandingReservations(tx, organizationId, orderId, locationId);
      await lockScopes(tx, organizationId, discovered);
      const locked = new Set(discovered.map((scope) => `${scope.itemId}|${scope.locationId}`));
      const outstanding = (
        await outstandingReservations(tx, organizationId, orderId, locationId)
      ).filter((scope) => locked.has(`${scope.itemId}|${scope.locationId}`));

      // Server-minted, so the occurrence time is the server's: unlike a receipt
      // or an adjustment, nothing happened on the client to date this from.
      const occurredAt = new Date().toISOString();
      const entries: LedgerEntryDraft[] = outstanding.map((scope) => ({
        itemId: scope.itemId,
        locationId: scope.locationId,
        cause: "RESERVATION_RELEASE",
        onHandDelta: "0",
        reservedDelta: assertCanonicalDecimal(scope.net).negated().toFixed(),
        incomingDelta: "0",
        occurredAt,
        metadata: { orderId, reason },
      }));

      const revision = await mintRevision(tx);
      const records = buildRecords(commandId, organizationId, revision, entries);
      await this.assertResultingStateIsValid(tx, organizationId, records);

      // An order holding nothing outstanding still records the command and
      // consumes a revision, and posts no rows. The client cannot know the
      // order was already empty, so an empty release is a legitimate no-op
      // rather than an error — and a zero-delta row would violate the
      // moves_something constraint anyway.
      const result: AppendResult = { revision, duplicate: false, entries: records };
      await persist(tx, commandId, organizationId, result);
      return result;
    });
  }

  /**
   * The stored result for a command already applied by this organization.
   *
   * A replay returns the original result and posts nothing, so a client
   * retrying an unacknowledged command is safe.
   *
   * Scoped by organization because commandId is client-supplied. Without the
   * filter, one tenant naming an id another has used receives that tenant's
   * stored entries as a "duplicate" while its own command silently never
   * applies.
   */
  private async findReplay(
    tx: Sql,
    commandId: string,
    organizationId: string,
  ): Promise<AppendResult | null> {
    const existing = await tx`
      SELECT result_json FROM processed_commands
      WHERE command_id = ${commandId} AND organization_id = ${organizationId}
    `;
    if (existing.length === 0) return null;
    return { ...(existing[0]!["result_json"] as AppendResult), duplicate: true };
  }

  /** Reject any command that would drive committed stock invalid. */
  private async assertResultingStateIsValid(
    tx: Sql,
    organizationId: string,
    records: readonly LedgerEntryRecord[],
  ): Promise<void> {
    const scopes = [...new Set(records.map((e) => `${e.itemId}|${e.locationId}`))];
    for (const scope of scopes) {
      const [itemId, locationId] = scope.split("|") as [string, string];
      const current = await this.readEntries(tx, organizationId, itemId);
      const scoped = records.filter((r) => r.itemId === itemId && r.locationId === locationId);
      const combined: LedgerEntryInput[] = [
        ...current.filter((e) => e.locationId === locationId),
        ...scoped,
      ].map((e) => ({
        eventId: e.eventId,
        itemId: e.itemId,
        locationId: e.locationId,
        cause: e.cause,
        onHandDelta: e.onHandDelta,
        reservedDelta: e.reservedDelta,
        incomingDelta: e.incomingDelta,
        occurredAt: e.occurredAt,
        revision: e.revision,
      }));

      const projected = projectInventory(combined);

      // Decimal comparison, not Number. Converting a numeric(24,8) quantity to
      // a JavaScript float to decide whether stock is sufficient would defeat
      // the exactness this whole package exists to preserve.
      const reserved = assertCanonicalDecimal(projected.reserved);
      const onHand = assertCanonicalDecimal(projected.onHand);

      // Reserved may never exceed on-hand: that is what "promising the same
      // stock twice" looks like in the data.
      if (reserved.greaterThan(onHand)) {
        const requested = scoped
          .reduce((total, r) => total.plus(assertCanonicalDecimal(r.reservedDelta)), assertCanonicalDecimal("0"))
          .toFixed();
        throw new InsufficientAvailableError(itemId, locationId, requested, projected.available);
      }
      if (onHand.isNegative()) {
        throw new InsufficientAvailableError(itemId, locationId, "on-hand", projected.onHand);
      }

      // Reserved and incoming are magnitudes; below zero they are not a shortage
      // but a corrupted count. Reachable from a caller-supplied outstanding
      // quantity that overshoots what the ledger actually holds, and every
      // planner downstream then reasons from the corrupted number.
      if (reserved.isNegative()) {
        throw new InvalidLedgerStateError(itemId, locationId, "reserved", projected.reserved);
      }
      const incoming = assertCanonicalDecimal(projected.incoming);
      if (incoming.isNegative()) {
        throw new InvalidLedgerStateError(itemId, locationId, "incoming", projected.incoming);
      }
    }
  }

  private async readEntries(
    tx: Sql,
    organizationId: string,
    itemId: string,
  ): Promise<LedgerEntryRecord[]> {
    const rows = await tx`
      SELECT id, organization_id, location_id, item_id, command_id, cause,
             on_hand_delta::text, reserved_delta::text, incoming_delta::text,
             occurred_at, revision::text, compensates_event_id, metadata
      FROM inventory_ledger_entries
      WHERE organization_id = ${organizationId} AND item_id = ${itemId}
      ORDER BY revision ASC, id ASC
    `;
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: Record<string, unknown>): LedgerEntryRecord {
    return {
      eventId: String(row["id"]),
      organizationId: String(row["organization_id"]),
      locationId: String(row["location_id"]),
      itemId: String(row["item_id"]),
      commandId: String(row["command_id"]),
      cause: row["cause"] as LedgerEntryRecord["cause"],
      onHandDelta: normalise(String(row["on_hand_delta"])),
      reservedDelta: normalise(String(row["reserved_delta"])),
      incomingDelta: normalise(String(row["incoming_delta"])),
      occurredAt: new Date(row["occurred_at"] as string).toISOString(),
      revision: String(row["revision"]),
      compensatesEventId: row["compensates_event_id"] ? String(row["compensates_event_id"]) : null,
      metadata: (row["metadata"] ?? {}) as Record<string, unknown>,
    };
  }

  async getProjection(
    organizationId: string,
    itemId: string,
    locationId: string,
  ): Promise<ProjectionRecord> {
    const entries = await this.readEntries(this.sql, organizationId, itemId);
    const projected = projectInventory(
      entries
        .filter((e) => e.locationId === locationId)
        .map((e) => ({
          eventId: e.eventId,
          itemId: e.itemId,
          locationId: e.locationId,
          cause: e.cause,
          onHandDelta: e.onHandDelta,
          reservedDelta: e.reservedDelta,
          incomingDelta: e.incomingDelta,
          occurredAt: e.occurredAt,
          revision: e.revision,
        })),
    );
    return {
      itemId,
      locationId,
      onHand: projected.onHand,
      reserved: projected.reserved,
      incoming: projected.incoming,
      available: projected.available,
      revision: projected.revision,
    };
  }

  async listEntries(
    organizationId: string,
    itemId: string,
  ): Promise<readonly LedgerEntryRecord[]> {
    return this.readEntries(this.sql, organizationId, itemId);
  }
}

type LedgerScope = Readonly<{ itemId: string; locationId: string }>;

/**
 * Serialise per item/location.
 *
 * Advisory locks rather than SELECT FOR UPDATE because the first command for an
 * item has no row to lock yet. Sorted, so two transactions wanting the same two
 * scopes cannot each hold one and wait for the other.
 */
async function lockScopes(
  tx: Sql,
  organizationId: string,
  scopes: readonly LedgerScope[],
): Promise<void> {
  const keys = [
    ...new Set(scopes.map((scope) => `${organizationId}:${scope.itemId}:${scope.locationId}`)),
  ].sort();
  for (const key of keys) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/** A sequence rather than max()+1, so concurrent commands cannot share one. */
async function mintRevision(tx: Sql): Promise<string> {
  const rows = await tx`SELECT nextval('inventory_revision_seq')::text AS revision`;
  return rows[0]!["revision"] as string;
}

function buildRecords(
  commandId: string,
  organizationId: string,
  revision: string,
  entries: readonly LedgerEntryDraft[],
): LedgerEntryRecord[] {
  return entries.map((draft) => ({
    ...draft,
    // Quantised before the value is used for validation OR returned, so the
    // caller, the check and the row all agree.
    onHandDelta: quantise(draft.onHandDelta),
    reservedDelta: quantise(draft.reservedDelta),
    incomingDelta: quantise(draft.incomingDelta),
    eventId: randomUUID(),
    commandId,
    organizationId,
    revision,
  }));
}

/**
 * Each item/location this order still holds reservation against, and how much.
 *
 * Net, not gross: an order that was partly handed back already has
 * RESERVATION_RELEASE rows of its own, and releasing the gross reservation
 * would give back stock twice.
 *
 * Strictly positive, not merely non-zero. A zero net has nothing to release and
 * its row would move nothing, which the moves_something constraint forbids. A
 * NEGATIVE net means the order has already been given back more than it ever
 * took, and negating it would post a release that RESERVES — turning a
 * cancellation into a promise of stock.
 *
 * Skipping a negative net protects THIS order, not its neighbours. Validation
 * guards the item's total reserved and never a per-order net, so an
 * over-released order leaves the item total lower than the orders still
 * outstanding believe it to be. A neighbouring order's honest, fully-earned
 * release is then the command that would drive the item's reserved below zero,
 * and it — not the order that actually overdrew — is the one refused with
 * InvalidLedgerStateError. Known, and deliberately not fixed here: making a
 * release answer for its neighbours means reconciling per-order nets against
 * the item total, which is order-state-machine work rather than ledger work.
 */
async function outstandingReservations(
  tx: Sql,
  organizationId: string,
  orderId: string,
  locationId: string,
): Promise<readonly (LedgerScope & { net: string })[]> {
  const rows = await tx`
    SELECT item_id, location_id, SUM(reserved_delta)::text AS net
    FROM inventory_ledger_entries
    WHERE organization_id = ${organizationId}
      AND location_id = ${locationId}
      AND metadata->>'orderId' = ${orderId}
      AND cause IN ('ORDER_RESERVATION', 'RESERVATION_RELEASE')
    GROUP BY item_id, location_id
    HAVING SUM(reserved_delta) > 0
    ORDER BY item_id ASC
  `;
  return rows.map((row) => ({
    itemId: String(row["item_id"]),
    locationId: String(row["location_id"]),
    net: normalise(String(row["net"])),
  }));
}

/**
 * Record the command, then its entries.
 *
 * command_id stays the global primary key, so this insert conflicts whenever
 * the replay lookup missed a row that another transaction has since committed.
 * The catch is scoped to this ONE statement so the conflict is known to be about
 * a command id and not some other constraint; who owns that id is decided by
 * resolveCommandIdConflict, which needs a connection this aborted transaction
 * can no longer offer.
 */
async function persist(
  tx: Sql,
  commandId: string,
  organizationId: string,
  result: AppendResult,
): Promise<void> {
  try {
    await tx`
      INSERT INTO processed_commands (command_id, organization_id, result_json)
      VALUES (${commandId}, ${organizationId}, ${tx.json(result as never)})
    `;
  } catch (error) {
    if (isUniqueViolation(error)) throw new CommandIdCollisionError(commandId);
    throw error;
  }

  for (const record of result.entries) {
    await tx`
      INSERT INTO inventory_ledger_entries (
        id, organization_id, location_id, item_id, command_id, cause,
        on_hand_delta, reserved_delta, incoming_delta, occurred_at, revision,
        compensates_event_id, metadata
      ) VALUES (
        ${record.eventId}, ${record.organizationId}, ${record.locationId}, ${record.itemId},
        ${record.commandId}, ${record.cause}, ${record.onHandDelta}, ${record.reservedDelta},
        ${record.incomingDelta}, ${record.occurredAt}, ${record.revision},
        ${record.compensatesEventId ?? null}, ${tx.json((record.metadata ?? {}) as never)}
      )
    `;
  }
}

/** SQLSTATE unique_violation. postgres.js surfaces it as `code` on the error. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Storage granularity, taken from the schema: numeric(24, 8).
 *
 * The domain computes at 40 digits, so a converted quantity can carry more than
 * eight decimals — 15.7 oz is exactly 445.0875130625 g, which has ten. Inserted
 * raw, PostgreSQL rounds it silently and a read-back no longer equals what was
 * written. Quantising HERE makes that loss explicit and single-sited: what a
 * caller is told was stored is exactly what was stored.
 *
 * Eight decimals of a gram is ten nanograms, far below any meaningful quantity
 * of wax. But "small enough not to matter" is a judgement that belongs in a
 * comment, not in an invisible database rounding.
 */
const STORAGE_DECIMALS = 8;

/** Round a domain quantity to what the column can actually hold. */
function quantise(value: string): string {
  return assertCanonicalDecimal(value).toDecimalPlaces(STORAGE_DECIMALS).toFixed();
}

/**
 * PostgreSQL renders numeric(24,8) with trailing zeroes ("100.00000000").
 * The domain's canonical form has none, so normalise at the boundary rather
 * than letting two spellings of the same quantity circulate.
 */
function normalise(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}
