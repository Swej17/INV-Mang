import { Decimal, assertCanonicalDecimal } from "../units/convert.js";
import type { LedgerCauseName } from "./ledger-causes.js";

/**
 * Derives current stock from immutable ledger entries.
 *
 * Quantities are never stored as a mutable running total. A projection is
 * always the sum of its entries, so it can be rebuilt from history at any time
 * and a disagreement between the two is impossible by construction rather than
 * by discipline.
 */

export type LedgerEntryInput = Readonly<{
  eventId: string;
  itemId: string;
  locationId: string;
  cause: LedgerCauseName;
  onHandDelta: string;
  reservedDelta: string;
  incomingDelta: string;
  occurredAt: string;
  revision: string;
  compensatesEventId?: string | null;
}>;

export type ProjectionOptions = Readonly<{
  /** Held back from availability when the owner has enabled protection. */
  protectedQuantity?: string;
}>;

export type InventoryProjectionResult = Readonly<{
  onHand: string;
  reserved: string;
  incoming: string;
  /** max(0, onHand - reserved - protected). Never negative, never stored. */
  available: string;
  protectedQuantity: string;
  revision: string;
  entryCount: number;
}>;

function sum(values: readonly string[]): InstanceType<typeof Decimal> {
  return values.reduce(
    (total, value) => total.plus(assertCanonicalDecimal(value)),
    new Decimal(0),
  );
}

export function projectInventory(
  entries: readonly LedgerEntryInput[],
  options: ProjectionOptions = {},
): InventoryProjectionResult {
  const protectedQuantity = assertCanonicalDecimal(options.protectedQuantity ?? "0");

  const onHand = sum(entries.map((entry) => entry.onHandDelta));
  const reserved = sum(entries.map((entry) => entry.reservedDelta));
  const incoming = sum(entries.map((entry) => entry.incomingDelta));

  // Incoming is deliberately absent: an inbound purchase order must never
  // inflate what can be promised today. It is surfaced separately and only
  // counts toward future-dated feasibility.
  const availableRaw = onHand.minus(reserved).minus(protectedQuantity);
  const available = availableRaw.isNegative() ? new Decimal(0) : availableRaw;

  // Highest revision wins regardless of array order, so a projection built
  // from out-of-order pages still reports the correct watermark.
  const revision = entries.reduce(
    (highest, entry) => {
      const current = new Decimal(entry.revision);
      return current.greaterThan(highest) ? current : highest;
    },
    new Decimal(0),
  );

  return {
    onHand: onHand.toFixed(),
    reserved: reserved.toFixed(),
    incoming: incoming.toFixed(),
    available: available.toFixed(),
    protectedQuantity: protectedQuantity.toFixed(),
    revision: revision.toFixed(),
    entryCount: entries.length,
  };
}
