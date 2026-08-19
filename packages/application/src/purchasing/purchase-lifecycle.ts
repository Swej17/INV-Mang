import { assertNonNegativeDecimal } from "@simple-flame/domain";
import type {
  InventoryLedgerRepository,
  LedgerEntryDraft,
} from "@simple-flame/persistence-contracts";

import type { Clock } from "../production/complete-batch.js";

/**
 * Marking a recommendation ordered, and receiving it.
 *
 * This system deliberately does NOT place orders with vendors. Marking ordered
 * records an expectation so future planning can account for stock already
 * committed; receiving turns that expectation into real on-hand.
 *
 * The two halves move different ledger fields on purpose. An expected inbound
 * moves `incomingDelta` only, never `onHandDelta` — inbound stock must never
 * make an order look shippable today.
 */

export type MarkOrderedInput = Readonly<{
  commandId: string;
  organizationId: string;
  purchaseOrderId: string;
  itemId: string;
  locationId: string;
  /** Purchase units ordered. */
  orderedQuantity: string;
  /** Base units delivered per purchase unit. */
  packConversion: string;
  expectedArrival: string | null;
}>;

export type ReceivePurchaseInput = Readonly<{
  commandId: string;
  organizationId: string;
  purchaseOrderId: string;
  itemId: string;
  locationId: string;
  /** Base units actually received, which may differ from what was ordered. */
  receivedBaseQuantity: string;
  /** Base units still outstanding on this order, for a partial receipt. */
  outstandingBaseQuantity: string;
  lot?: Readonly<{
    lotId: string;
    supplierLotNumber: string | null;
    receivedDate: string;
    bestByDate: string | null;
    unitCost: string | null;
  }>;
}>;

export type PurchaseLifecycleDeps = Readonly<{
  ledger: InventoryLedgerRepository;
  clock: Clock;
}>;

export class PurchaseLifecycle {
  constructor(private readonly deps: PurchaseLifecycleDeps) {}

  /** Record an expected inbound. Moves incoming only. */
  async markOrdered(input: MarkOrderedInput): Promise<{ revision: string }> {
    const quantity = assertNonNegativeDecimal(input.orderedQuantity, "orderedQuantity");
    const conversion = assertNonNegativeDecimal(input.packConversion, "packConversion");
    if (quantity.isZero()) throw new Error("orderedQuantity must be greater than zero");
    if (conversion.isZero()) throw new Error("packConversion must be greater than zero");

    const entry: LedgerEntryDraft = {
      itemId: input.itemId,
      locationId: input.locationId,
      cause: "SYNCHRONIZATION_CORRECTION",
      onHandDelta: "0",
      reservedDelta: "0",
      // Incoming only. Nothing has physically arrived.
      incomingDelta: quantity.times(conversion).toFixed(),
      occurredAt: this.deps.clock.now(),
      metadata: {
        purchaseOrderId: input.purchaseOrderId,
        expectedArrival: input.expectedArrival,
        kind: "PURCHASE_ORDERED",
      },
    };

    const result = await this.deps.ledger.appendOnce(input.commandId, input.organizationId, [entry]);
    return { revision: result.revision };
  }

  /**
   * Receive stock against an expected inbound.
   *
   * Both sides move in ONE command: on-hand rises and the matching expectation
   * clears together. Posting them separately would leave a window where the same
   * stock counts as both incoming and on-hand, overstating what is available.
   */
  async receive(input: ReceivePurchaseInput): Promise<{ revision: string }> {
    const received = assertNonNegativeDecimal(input.receivedBaseQuantity, "receivedBaseQuantity");
    if (received.isZero()) throw new Error("receivedBaseQuantity must be greater than zero");
    const outstanding = assertNonNegativeDecimal(
      input.outstandingBaseQuantity,
      "outstandingBaseQuantity",
    );

    // Clear only what this receipt satisfies. A short delivery leaves the
    // remainder outstanding rather than silently cancelling it, and an
    // over-delivery must not drive incoming negative on an unrelated order.
    const clearing = received.greaterThan(outstanding) ? outstanding : received;

    const entry: LedgerEntryDraft = {
      itemId: input.itemId,
      locationId: input.locationId,
      cause: "RECEIPT",
      onHandDelta: received.toFixed(),
      reservedDelta: "0",
      incomingDelta: clearing.negated().toFixed(),
      occurredAt: this.deps.clock.now(),
      metadata: {
        purchaseOrderId: input.purchaseOrderId,
        kind: "PURCHASE_RECEIVED",
        ...(input.lot ? { lot: input.lot } : {}),
      },
    };

    const result = await this.deps.ledger.appendOnce(input.commandId, input.organizationId, [entry]);
    return { revision: result.revision };
  }
}
