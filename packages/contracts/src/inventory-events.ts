import { z } from "zod";

import { LEDGER_CAUSES } from "@simple-flame/domain";

import { DecimalString, IsoDateTime, Revision, Uuid } from "./common.js";

/**
 * Immutable ledger entries.
 *
 * Posted events are never edited or deleted. A mistake is corrected by
 * appending a compensating entry, so the history of what was believed at each
 * point in time survives the correction.
 */

/**
 * Derived from the domain constant, never restated.
 *
 * A review proved the cost of duplication here: this vocabulary existed in three
 * places — domain, this schema, and the SQL CHECK — and mutations that deleted a
 * cause from the domain array or the CHECK both survived, because only this copy
 * was tested. Deriving means the domain and the wire schema now fail together.
 */
export const LedgerCause = z.enum(LEDGER_CAUSES);

export const InventoryEventV1 = z.object({
  version: z.literal(1),
  eventId: Uuid,
  /** The command that produced this entry; duplicates must not post twice. */
  commandId: Uuid,
  organizationId: Uuid,
  locationId: Uuid,
  itemId: Uuid,
  cause: LedgerCause,
  /**
   * Deltas, never absolutes. A projection is the sum of its entries, so an
   * absolute value here would make history unreplayable.
   */
  onHandDelta: DecimalString,
  reservedDelta: DecimalString,
  incomingDelta: DecimalString,
  occurredAt: IsoDateTime,
  revision: Revision,
  /** Set when this entry reverses an earlier one. */
  compensatesEventId: Uuid.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type InventoryEvent = z.infer<typeof InventoryEventV1>;
export type LedgerCauseValue = z.infer<typeof LedgerCause>;
