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

  /** Derived stock for one item at one location. */
  getProjection(itemId: string, locationId: string): Promise<ProjectionRecord>;

  /** Full history for an item, oldest first. Never mutated, only appended to. */
  listEntries(itemId: string): Promise<readonly LedgerEntryRecord[]>;
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
