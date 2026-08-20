import type { LedgerCauseName } from "@simple-flame/domain";

/**
 * The port every ledger adapter implements.
 *
 * Defined here rather than in an adapter so PostgreSQL today, IndexedDB in
 * Task 13 and SQLite in Phase 2 are held to one behavioural contract, verified
 * by the same suite. An adapter that passes its own bespoke tests proves
 * nothing about parity.
 */

export type LedgerEntryDraft = Readonly<{
  itemId: string;
  locationId: string;
  cause: LedgerCauseName;
  onHandDelta: string;
  reservedDelta: string;
  incomingDelta: string;
  occurredAt: string;
  compensatesEventId?: string | null;
  metadata?: Record<string, unknown>;
}>;

export type LedgerEntryRecord = LedgerEntryDraft &
  Readonly<{
    eventId: string;
    commandId: string;
    organizationId: string;
    revision: string;
  }>;

export type AppendResult = Readonly<{
  /** Server revision after this command was applied. */
  revision: string;
  /** True when the command had already been applied and nothing was posted. */
  duplicate: boolean;
  entries: readonly LedgerEntryRecord[];
}>;

export type ProjectionRecord = Readonly<{
  itemId: string;
  locationId: string;
  onHand: string;
  reserved: string;
  incoming: string;
  available: string;
  revision: string;
}>;

export interface InventoryLedgerRepository {
  /**
   * Append entries under a command id, exactly once.
   *
   * Replaying the same `commandId` must return the ORIGINAL result without
   * posting a second set of entries. This is the whole basis of offline
   * safety: a client that retries an unacknowledged command must not double
   * its effect.
   */
  appendOnce(
    commandId: string,
    organizationId: string,
    entries: readonly LedgerEntryDraft[],
  ): Promise<AppendResult>;

  /**
   * Hand back whatever one order still has reserved at one location.
   *
   * The amounts are the adapter's to derive from the order's own reservation
   * history, not the caller's to supply: a client that has been offline cannot
   * know how much the server still holds, and an overshooting figure would
   * drive reserved negative. Idempotent on `commandId` like `appendOnce`, and
   * an order with nothing outstanding is a recorded no-op rather than an error
   * — the client cannot know the order was already empty.
   */
  releaseOrder(
    commandId: string,
    organizationId: string,
    orderId: string,
    locationId: string,
    reason: string,
  ): Promise<AppendResult>;

  /**
   * Derived stock for one item at one location, within ONE organization.
   *
   * organizationId is not optional and is not inferable from the item: two
   * organizations can legitimately hold the same item id (seeded catalogue,
   * restore, fixture reuse), and reading across them let one tenant consume
   * stock it did not own and drive itself negative.
   */
  getProjection(
    organizationId: string,
    itemId: string,
    locationId: string,
  ): Promise<ProjectionRecord>;

  /** Full history for one organization's item, oldest first. Append-only. */
  listEntries(organizationId: string, itemId: string): Promise<readonly LedgerEntryRecord[]>;
}

/** Raised when a command would drive committed stock into an invalid state. */
export class InsufficientAvailableError extends Error {
  constructor(
    readonly itemId: string,
    readonly locationId: string,
    readonly requested: string,
    readonly available: string,
  ) {
    super(
      `insufficient available for item ${itemId} at ${locationId}: requested ${requested}, available ${available}`,
    );
    this.name = "InsufficientAvailableError";
  }
}

/**
 * Raised when one organization submits a command id another has already used.
 *
 * `commandId` is client-supplied, so this is reachable from outside. Replaying
 * the first organization's result would leak its entries and silently discard
 * the second's command, so a collision must fail loudly instead.
 */
export class CommandIdCollisionError extends Error {
  constructor(readonly commandId: string) {
    super(`command id ${commandId} is already in use by another organization`);
    this.name = "CommandIdCollisionError";
  }
}

/**
 * Raised when a command would drive a projected quantity to a value the ledger
 * cannot mean — reserved or incoming below zero.
 *
 * Distinct from InsufficientAvailableError: that one reports stock a caller
 * asked for and cannot have, this one reports a caller-supplied delta that
 * contradicts history the repository already holds.
 */
export class InvalidLedgerStateError extends Error {
  constructor(
    readonly itemId: string,
    readonly locationId: string,
    readonly field: "reserved" | "incoming",
    readonly value: string,
  ) {
    super(`invalid ${field} for item ${itemId} at ${locationId}: would become ${value}`);
    this.name = "InvalidLedgerStateError";
  }
}
