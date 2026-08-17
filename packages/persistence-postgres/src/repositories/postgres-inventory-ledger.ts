import { randomUUID } from "node:crypto";

import { assertCanonicalDecimal, projectInventory, type LedgerEntryInput } from "@simple-flame/domain";
import {
  InsufficientAvailableError,
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
    return this.sql.begin(async (tx) => {
      // Idempotency first: a replay returns the original result and posts
      // nothing, so a client retrying an unacknowledged command is safe.
      const existing = await tx`
        SELECT result_json FROM processed_commands WHERE command_id = ${commandId}
      `;
      if (existing.length > 0) {
        const original = existing[0]!["result_json"] as AppendResult;
        return { ...original, duplicate: true };
      }

      // Serialise per item/location. advisory locks rather than SELECT FOR
      // UPDATE because the first command for an item has no row to lock yet.
      const scopes = [...new Set(entries.map((e) => `${e.itemId}:${e.locationId}`))].sort();
      for (const scope of scopes) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
      }

      const revision = (
        await tx`SELECT nextval('inventory_revision_seq')::text AS revision`
      )[0]!["revision"] as string;

      const records: LedgerEntryRecord[] = [];
      for (const draft of entries) {
        records.push({
          ...draft,
          // Quantised before the value is used for validation OR returned, so
          // the caller, the check and the row all agree.
          onHandDelta: quantise(draft.onHandDelta),
          reservedDelta: quantise(draft.reservedDelta),
          incomingDelta: quantise(draft.incomingDelta),
          eventId: randomUUID(),
          commandId,
          organizationId,
          revision,
        });
      }

      // Validate the resulting state BEFORE writing anything. Postgres would
      // roll the transaction back anyway, but a typed error is more useful to
      // the sync layer than a constraint violation.
      await this.assertResultingStateIsValid(tx, entries, records);

      const result: AppendResult = { revision, duplicate: false, entries: records };

      await tx`
        INSERT INTO processed_commands (command_id, organization_id, result_json)
        VALUES (${commandId}, ${organizationId}, ${tx.json(result as never)})
      `;

      for (const record of records) {
        await tx`
          INSERT INTO inventory_ledger_entries (
            id, organization_id, location_id, item_id, command_id, cause,
            on_hand_delta, reserved_delta, incoming_delta, occurred_at, revision,
            compensates_event_id, metadata
          ) VALUES (
            ${record.eventId}, ${organizationId}, ${record.locationId}, ${record.itemId},
            ${commandId}, ${record.cause}, ${record.onHandDelta}, ${record.reservedDelta},
            ${record.incomingDelta}, ${record.occurredAt}, ${revision},
            ${record.compensatesEventId ?? null}, ${tx.json((record.metadata ?? {}) as never)}
          )
        `;
      }

      return result;
    });
  }

  /** Reject any command that would drive committed stock invalid. */
  private async assertResultingStateIsValid(
    tx: Sql,
    drafts: readonly LedgerEntryDraft[],
    records: readonly LedgerEntryRecord[],
  ): Promise<void> {
    const scopes = [...new Set(drafts.map((e) => `${e.itemId}|${e.locationId}`))];
    for (const scope of scopes) {
      const [itemId, locationId] = scope.split("|") as [string, string];
      const current = await this.readEntries(tx, itemId);
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
    }
  }

  private async readEntries(tx: Sql, itemId: string): Promise<LedgerEntryRecord[]> {
    const rows = await tx`
      SELECT id, organization_id, location_id, item_id, command_id, cause,
             on_hand_delta::text, reserved_delta::text, incoming_delta::text,
             occurred_at, revision::text, compensates_event_id, metadata
      FROM inventory_ledger_entries
      WHERE item_id = ${itemId}
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

  async getProjection(itemId: string, locationId: string): Promise<ProjectionRecord> {
    const entries = await this.readEntries(this.sql, itemId);
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

  async listEntries(itemId: string): Promise<readonly LedgerEntryRecord[]> {
    return this.readEntries(this.sql, itemId);
  }
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
