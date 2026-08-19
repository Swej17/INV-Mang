/**
 * The closed set of reasons stock may move.
 *
 * Lives in the domain so the projection, the persistence schema and the wire
 * contract all constrain themselves to the same vocabulary. A cause that
 * exists in one layer but not another is how ledgers grow silent gaps.
 */
export const LEDGER_CAUSES = [
  "RECEIPT",
  // An expected inbound, not stock in hand. Distinct from RECEIPT because
  // ordering and arriving are different events with different consequences.
  "PURCHASE_ORDERED",
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
] as const;

export type LedgerCauseName = (typeof LEDGER_CAUSES)[number];
