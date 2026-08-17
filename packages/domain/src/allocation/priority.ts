import { Decimal, assertCanonicalDecimal } from "../units/convert.js";
import type { RecipeComponent } from "../capacity/calculate-capacity.js";

/**
 * What the owner wants made, and everything needed to rank it.
 *
 * Ranking inputs are carried on the demand rather than looked up during the
 * sort, so ordering is a pure function of its input and a plan can be replayed
 * to the same result.
 */
export type ProductionDemand = Readonly<{
  finishedItemId: string;
  sku: string;
  requestedUnits: number;
  recipeVersionId: string;
  components: readonly RecipeComponent[];
  /** Due date of the paid order this demand serves, if any. */
  paidOrderDueAt: string | null;
  /** Units an existing order still cannot cover from finished stock. */
  orderShortfallUnits: number;
  ownerPriority: number;
  forecastStockoutAt: string | null;
  salesVelocity: string;
}>;

/** Earlier date first; null sorts last, since "no deadline" never outranks one. */
function compareDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * The documented default priority, in order:
 *   1. paid order due date
 *   2. existing order production shortfall
 *   3. owner-assigned priority
 *   4. forecast stockout date
 *   5. recent sales velocity
 *   6. SKU, as a deterministic tie-breaker
 *
 * Step 6 exists so an allocation is reproducible. Without it two demands equal
 * on every business axis would order by whatever the sort happened to do, and
 * the same plan could allocate differently on a re-run.
 */
export function comparePriority(a: ProductionDemand, b: ProductionDemand): number {
  const byDueDate = compareDate(a.paidOrderDueAt, b.paidOrderDueAt);
  if (byDueDate !== 0) return byDueDate;

  const byShortfall =
    Number(b.orderShortfallUnits > 0) - Number(a.orderShortfallUnits > 0);
  if (byShortfall !== 0) return byShortfall;

  if (b.ownerPriority !== a.ownerPriority) return b.ownerPriority - a.ownerPriority;

  const byStockout = compareDate(a.forecastStockoutAt, b.forecastStockoutAt);
  if (byStockout !== 0) return byStockout;

  // Decimal, not Number: velocity feeds a business decision and two values
  // differing below float precision must still order deterministically.
  const velocity = assertCanonicalDecimal(b.salesVelocity).comparedTo(
    assertCanonicalDecimal(a.salesVelocity),
  );
  if (velocity !== null && velocity !== 0) return velocity;

  return a.sku.localeCompare(b.sku);
}

export { Decimal };
