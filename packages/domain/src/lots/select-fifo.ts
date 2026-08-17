import { Decimal, assertCanonicalDecimal } from "../units/convert.js";

/**
 * Which lots to consume, oldest first.
 *
 * Proposes rather than commits: the owner may override the selection, and an
 * override is audited. What this guarantees is that the DEFAULT proposal is
 * deterministic and uses the oldest stock, so wax does not quietly age out at
 * the back of a shelf while newer wax gets poured.
 */

export type Lot = Readonly<{
  lotId: string;
  /** ISO date. Primary FIFO key. */
  receivedDate: string;
  /** ISO date or null when the material does not expire. */
  bestByDate: string | null;
  /** Quantity still available in this lot, in the item's base unit. */
  remaining: string;
}>;

export type LotDraw = Readonly<{
  lotId: string;
  quantity: string;
}>;

/** Nulls sort last: "never expires" is not more urgent than a real date. */
function compareNullableDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Received date, then best-by date, then lot id.
 *
 * The lot id tie-breaker is not decoration. Without it, two lots identical on
 * both dates would order by whatever the input happened to be, so a dry run and
 * the committed batch could consume different lots and traceability would be
 * wrong after the fact.
 */
function compareLots(a: Lot, b: Lot): number {
  if (a.receivedDate !== b.receivedDate) return a.receivedDate < b.receivedDate ? -1 : 1;
  const byBestBy = compareNullableDate(a.bestByDate, b.bestByDate);
  if (byBestBy !== 0) return byBestBy;
  return a.lotId.localeCompare(b.lotId);
}

export function selectFifoLots(lots: readonly Lot[], requiredQuantity: string): readonly LotDraw[] {
  let outstanding = assertCanonicalDecimal(requiredQuantity);
  if (outstanding.isZero()) return [];
  if (outstanding.isNegative()) {
    throw new Error(`invalid quantity: ${requiredQuantity} (cannot consume a negative amount)`);
  }

  const ordered = [...lots].sort(compareLots);
  const draws: LotDraw[] = [];

  for (const lot of ordered) {
    if (outstanding.isZero()) break;
    const available = assertCanonicalDecimal(lot.remaining);
    if (available.lessThanOrEqualTo(0)) continue;

    const take = available.greaterThanOrEqualTo(outstanding) ? outstanding : available;
    draws.push({ lotId: lot.lotId, quantity: take.toFixed() });
    outstanding = outstanding.minus(take);
  }

  if (outstanding.greaterThan(0)) {
    // Failing loudly matters: a short selection would let a batch consume less
    // than the recipe requires and still report success, silently inflating
    // yield and understating cost.
    throw new Error(
      `insufficient lot quantity: ${outstanding.toFixed()} short of ${requiredQuantity}`,
    );
  }

  return draws;
}

/** Total a set of draws consumes; used to check an override against the recipe. */
export function totalDrawn(draws: readonly LotDraw[]): string {
  return draws
    .reduce((total, draw) => total.plus(assertCanonicalDecimal(draw.quantity)), new Decimal(0))
    .toFixed();
}
