import { Decimal, assertNonNegativeDecimal } from "../units/convert.js";

/**
 * What to buy, from whom, how much, and by when.
 *
 * Every number here is explainable. The design document forbids opaque
 * recommendations, so the result carries its inputs and a written reason: an
 * owner about to spend money is entitled to see why, and a recommendation
 * nobody understands is one nobody trusts.
 */

export type VendorOffer = Readonly<{
  vendorId: string;
  vendorName: string;
  preferred: boolean;
  productUrl: string | null;
  vendorSku: string | null;
  /** Base units delivered per purchase unit. A 10 lb case of wax is 4535.9237. */
  packConversion: string;
  /** Purchase units per pack; orders round up to a whole pack. */
  packSize: string;
  minimumOrderQuantity: string;
  reorderMultiple: string;
  unitPrice: string;
  leadTimeDays: number;
  shippingEstimate: string;
}>;

export type ReorderPolicy = Readonly<{
  itemId: string;
  /** Base units consumed per day. */
  dailyDemand: string;
  available: string;
  /** Inbound stock expected before it is needed. */
  usableIncoming: string;
  protectedQuantity: string;
  safetyDays: number;
  targetCoverageDays: number;
  asOf: string;
  offers: readonly VendorOffer[];
}>;

export type PurchaseRecommendation = Readonly<{
  itemId: string;
  shouldReorder: boolean;
  reorderPoint: string;
  recommendedPurchaseUnits: string;
  vendorId: string;
  vendorName: string;
  alternateVendorIds: readonly string[];
  productUrl: string | null;
  estimatedCost: string;
  /** Null when demand is zero: nothing is running out. */
  expectedStockoutAt: string | null;
  orderByAt: string | null;
  /** True when the order-by date has already passed. */
  overdue: boolean;
  reason: string;
  inputs: Readonly<Record<string, string | number>>;
}>;

const MS_PER_DAY = 86_400_000;

function addDays(iso: string, days: InstanceType<typeof Decimal>): string {
  // floor: a partial day of cover does not buy a whole extra day.
  const whole = days.floor().toNumber();
  return new Date(Date.parse(iso) + whole * MS_PER_DAY).toISOString();
}

/** Round up to whole packs, the reorder multiple, and the minimum order. */
function roundUpToVendorRules(
  needed: InstanceType<typeof Decimal>,
  offer: VendorOffer,
): InstanceType<typeof Decimal> {
  const packSize = assertNonNegativeDecimal(offer.packSize, "packSize");
  const multiple = assertNonNegativeDecimal(offer.reorderMultiple, "reorderMultiple");
  const minimum = assertNonNegativeDecimal(offer.minimumOrderQuantity, "minimumOrderQuantity");

  let quantity = needed;
  if (packSize.greaterThan(0)) quantity = quantity.dividedBy(packSize).ceil().times(packSize);
  if (multiple.greaterThan(0)) quantity = quantity.dividedBy(multiple).ceil().times(multiple);
  if (quantity.lessThan(minimum)) quantity = minimum;
  return quantity;
}

/**
 * Preferred vendor wins; otherwise the cheapest.
 *
 * Price is the tie-breaker rather than the primary rule because a preferred
 * vendor usually reflects a relationship or a quality decision the owner has
 * already made, and silently switching suppliers to save a few cents is not
 * this system's call.
 */
function chooseOffer(offers: readonly VendorOffer[]): VendorOffer {
  const preferred = offers.filter((offer) => offer.preferred);
  const pool = preferred.length > 0 ? preferred : offers;
  return [...pool].sort((a, b) => {
    // Prices validate like quantities: decimal.js would silently read "1e3" as
    // 1000, and this value is money the owner spends against.
    const byPrice = assertNonNegativeDecimal(a.unitPrice, "unitPrice").comparedTo(
      assertNonNegativeDecimal(b.unitPrice, "unitPrice"),
    );
    if (byPrice !== null && byPrice !== 0) return byPrice;
    return a.vendorId.localeCompare(b.vendorId);
  })[0]!;
}

export function recommendPurchase(policy: ReorderPolicy): PurchaseRecommendation {
  if (policy.offers.length === 0) {
    throw new Error(`no vendor offer for item ${policy.itemId}`);
  }

  const dailyDemand = assertNonNegativeDecimal(policy.dailyDemand, "dailyDemand");
  const available = assertNonNegativeDecimal(policy.available, "available");
  const usableIncoming = assertNonNegativeDecimal(policy.usableIncoming, "usableIncoming");
  const protectedQuantity = assertNonNegativeDecimal(policy.protectedQuantity, "protectedQuantity");

  const offer = chooseOffer(policy.offers);
  const packConversion = assertNonNegativeDecimal(offer.packConversion, "packConversion");
  if (packConversion.isZero()) {
    throw new Error(`packConversion for vendor ${offer.vendorId} must be greater than zero`);
  }

  // Reorder point: cover the lead time, plus a safety buffer, plus whatever is
  // held back and therefore cannot be consumed.
  const leadTimeDemand = dailyDemand.times(offer.leadTimeDays);
  const safetyDemand = dailyDemand.times(policy.safetyDays);
  const reorderPoint = leadTimeDemand.plus(safetyDemand).plus(protectedQuantity);

  const targetCoverage = dailyDemand.times(policy.targetCoverageDays);
  // Cover at least the reorder point. With targetCoverageDays below
  // leadTime + safety the two halves disagreed, and an item that was already
  // stocked out and past its order-by date reported shouldReorder: false.
  const coverageTarget = targetCoverage.greaterThan(reorderPoint) ? targetCoverage : reorderPoint;
  const rawNeed = coverageTarget.minus(available).minus(usableIncoming);
  // Never negative: "you have too much" is not an order.
  const needBase = rawNeed.isNegative() ? new Decimal(0) : rawNeed;

  const neededPurchaseUnits = needBase.dividedBy(packConversion);
  const recommended = needBase.isZero()
    ? new Decimal(0)
    : roundUpToVendorRules(neededPurchaseUnits, offer);

  // Stockout uses only what can actually be consumed today. Incoming stock is
  // excluded on purpose: it has not arrived, and treating it as cover is how an
  // order gets placed too late.
  const consumable = available.minus(protectedQuantity);
  const daysOfCover = dailyDemand.isZero()
    ? null
    : (consumable.isNegative() ? new Decimal(0) : consumable).dividedBy(dailyDemand);

  const expectedStockoutAt = daysOfCover === null ? null : addDays(policy.asOf, daysOfCover);
  const orderByAt =
    daysOfCover === null ? null : addDays(policy.asOf, daysOfCover.minus(offer.leadTimeDays));
  const overdue = orderByAt !== null && Date.parse(orderByAt) <= Date.parse(policy.asOf);

  const belowReorderPoint = available.plus(usableIncoming).lessThan(reorderPoint);
  const shouldReorder = belowReorderPoint && recommended.greaterThan(0);

  const unitPrice = assertNonNegativeDecimal(offer.unitPrice, "unitPrice");
  const shipping = assertNonNegativeDecimal(offer.shippingEstimate, "shippingEstimate");
  const estimatedCost = recommended
    .times(unitPrice)
    .plus(recommended.greaterThan(0) ? shipping : new Decimal(0));

  return {
    itemId: policy.itemId,
    shouldReorder,
    reorderPoint: reorderPoint.toFixed(),
    recommendedPurchaseUnits: recommended.toFixed(),
    vendorId: offer.vendorId,
    vendorName: offer.vendorName,
    alternateVendorIds: policy.offers
      .filter((other) => other.vendorId !== offer.vendorId)
      .map((other) => other.vendorId),
    productUrl: offer.productUrl,
    estimatedCost: estimatedCost.toFixed(),
    expectedStockoutAt,
    orderByAt,
    overdue,
    reason: belowReorderPoint
      ? `available ${available.toFixed()} plus incoming ${usableIncoming.toFixed()} is below reorder point ${reorderPoint.toFixed()}`
      : `available ${available.toFixed()} plus incoming ${usableIncoming.toFixed()} covers reorder point ${reorderPoint.toFixed()}`,
    inputs: {
      dailyDemand: dailyDemand.toFixed(),
      available: available.toFixed(),
      usableIncoming: usableIncoming.toFixed(),
      protectedQuantity: protectedQuantity.toFixed(),
      leadTimeDays: offer.leadTimeDays,
      safetyDays: policy.safetyDays,
      targetCoverageDays: policy.targetCoverageDays,
      targetCoverageDemand: targetCoverage.toFixed(),
      effectiveCoverageTarget: coverageTarget.toFixed(),
      packConversion: packConversion.toFixed(),
    },
  };
}
