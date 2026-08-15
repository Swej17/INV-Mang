import { z } from "zod";

import { DecimalString, IsoDateTime, Revision, Uuid } from "./common.js";

/**
 * Immutable ledger entries.
 *
 * Posted events are never edited or deleted. A mistake is corrected by
 * appending a compensating entry, so the history of what was believed at each
 * point in time survives the correction.
 */

export const LedgerCause = z.enum([
  "RECEIPT",
  "PHYSICAL_COUNT_ADJUSTMENT",
  "DAMAGE_OR_SPOILAGE",
  "PRODUCTION_ALLOCATION",
  "PRODUCTION_CONSUMPTION",
  "PRODUCTION_OUTPUT",
  "ORDER_RESERVATION",
  "RESERVATION_RELEASE",
  "FULFILLMENT_CONSUMPTION",
  "CUSTOMER_RETURN",
  "VENDOR_RETURN",
  "PROCESS_LOSS",
  "SYNCHRONIZATION_CORRECTION",
  "ADMINISTRATIVE_REVERSAL",
]);

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
