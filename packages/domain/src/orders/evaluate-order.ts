import { Decimal, assertCanonicalDecimal, assertNonNegativeDecimal } from "../units/convert.js";
import {
  calculateCapacity,
  requiredForUnits,
  type RecipeComponent,
} from "../capacity/calculate-capacity.js";
import type { DependencyClass } from "../inventory/types.js";

/**
 * Can this order be fulfilled, and if not, what exactly is missing?
 *
 * Production readiness and shipping readiness are computed SEPARATELY and never
 * merged into a single verdict. They fail for different reasons and are fixed by
 * different actions: pouring more candles does not conjure a shipping box, and
 * buying boxes does not make wax appear. A combined "not ready" would send the
 * owner to solve the wrong problem.
 */

export type ProductionReadiness =
  | "READY_FROM_FINISHED"
  | "MAKEABLE_BEFORE_DUE"
  | "PARTIAL"
  | "BLOCKED_PRODUCTION";

export type FulfillmentReadiness =
  | "READY"
  | "BLOCKED_FULFILLMENT_MATERIAL"
  | "READY_WITH_ADVISORY_WARNINGS";

export type OrderShortage = Readonly<{
  itemId: string;
  required: string;
  available: string;
  /** Inbound stock, reported for planning only. Never counted as available. */
  incoming: string;
  shortfall: string;
}>;

export type OrderLine = Readonly<{
  finishedItemId: string;
  orderedUnits: number;
  /** Finished stock on hand for this variant. */
  finishedAvailable: string;
  recipeVersionId: string;
  components: readonly RecipeComponent[];
}>;

export type PackingComponent = Readonly<{
  itemId: string;
  /** Quantity this order consumes. Callers scale per-unit rules before here. */
  perOrder: number;
  dependencyClass: DependencyClass;
}>;

export type OrderEvaluationInput = Readonly<{
  orderId: string;
  dueAt: string | null;
  assessedAt: string;
  /** When the server data behind this assessment was last known good. */
  lastAuthoritativeSyncAt: string;
  stalenessThresholdMinutes: number;
  lines: readonly OrderLine[];
  packingComponents: readonly PackingComponent[];
  availableByItem: Readonly<Record<string, string>>;
  incomingByItem?: Readonly<Record<string, string>>;
  protectedByItem?: Readonly<Record<string, string>>;
  lossEnabled: boolean;
}>;

export type OrderEvaluationResult = Readonly<{
  orderId: string;
  finishedAllocated: number;
  productionRequired: number;
  makeableUnits: number;
  productionStatus: ProductionReadiness;
  fulfillmentStatus: FulfillmentReadiness;
  productionBlockers: readonly OrderShortage[];
  fulfillmentBlockers: readonly OrderShortage[];
  advisoryWarnings: readonly OrderShortage[];
  /** True when the data behind this assessment is older than the threshold. */
  stale: boolean;
  lastAuthoritativeSyncAt: string;
}>;

function minutesBetween(laterIso: string, earlierIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 60_000;
}

function shortage(
  input: OrderEvaluationInput,
  itemId: string,
  required: InstanceType<typeof Decimal>,
  pool?: Map<string, InstanceType<typeof Decimal>>,
): OrderShortage | null {
  // Measured against USABLE stock. Reading availableByItem raw ignored
  // protected stock, so an item with 500 g all held back was reported as
  // having 500 available and a shortfall half its real size.
  const available =
    pool?.get(itemId) ??
    (() => {
      const raw = assertNonNegativeDecimal(input.availableByItem[itemId] ?? "0", "available");
      const held = input.protectedByItem?.[itemId];
      const usable = held === undefined
        ? raw
        : raw.minus(assertNonNegativeDecimal(held, "protectedQuantity"));
      return usable.isNegative() ? new Decimal(0) : usable;
    })();
  if (required.lessThanOrEqualTo(available)) return null;
  return {
    itemId,
    required: required.toFixed(),
    available: available.toFixed(),
    incoming: assertCanonicalDecimal(input.incomingByItem?.[itemId] ?? "0").toFixed(),
    shortfall: required.minus(available).toFixed(),
  };
}

export function evaluateOrder(input: OrderEvaluationInput): OrderEvaluationResult {
  // Finished goods first. Asking the owner to produce units they already have on
  // the shelf is the single most common way this kind of system wastes a day.
  //
  // Whole units only: finished stock is countable, and a Number() round trip
  // here previously produced fractional candles (2.9 allocated, 2.1 to make)
  // which then flowed into every downstream comparison.
  let finishedAllocated = 0;
  let productionRequired = 0;
  const perLineShortfall: { line: OrderLine; units: number }[] = [];
  for (const line of input.lines) {
    if (!Number.isInteger(line.orderedUnits) || line.orderedUnits < 0) {
      throw new Error(`orderedUnits must be a non-negative integer, received ${line.orderedUnits}`);
    }
    const onHand = assertNonNegativeDecimal(line.finishedAvailable, "finishedAvailable")
      .floor()
      .toNumber();
    const fromFinished = Math.min(line.orderedUnits, onHand);
    finishedAllocated += fromFinished;
    const shortfallUnits = line.orderedUnits - fromFinished;
    productionRequired += shortfallUnits;
    if (shortfallUnits > 0) perLineShortfall.push({ line, units: shortfallUnits });
  }

  // EVERY line is assessed, against a pool that decrements as each line claims
  // material. Evaluating only the first line reported a two-line order as
  // MAKEABLE with zero blockers when the second line's vessel was out of stock,
  // and named the first line's component as the blocker when it was in fact
  // sufficient — sending the owner to buy the wrong thing.
  let makeableUnits = 0;
  const productionBlockers: OrderShortage[] = [];
  const pool = new Map<string, InstanceType<typeof Decimal>>();
  for (const [itemId, value] of Object.entries(input.availableByItem)) {
    let available = assertNonNegativeDecimal(value, `availableByItem[${itemId}]`);
    const held = input.protectedByItem?.[itemId];
    if (held !== undefined) {
      available = available.minus(assertNonNegativeDecimal(held, `protectedByItem[${itemId}]`));
    }
    pool.set(itemId, available.isNegative() ? new Decimal(0) : available);
  }

  for (const { line, units } of perLineShortfall) {
    const availableForLine: Record<string, string> = {};
    for (const [itemId, remaining] of pool) availableForLine[itemId] = remaining.toFixed();

    const capacity = calculateCapacity({
      recipeVersionId: line.recipeVersionId,
      components: line.components,
      availableByItem: availableForLine,
      lossEnabled: input.lossEnabled,
    });
    const madeForLine = Math.min(capacity.adjustedUnits, units);
    makeableUnits += madeForLine;

    // Draw down before the next line, so two lines cannot both be promised the
    // same wax.
    for (const component of line.components) {
      if (component.dependencyClass !== "PRODUCTION_CRITICAL") continue;
      if (madeForLine <= 0) continue;
      const used = requiredForUnits(component, BigInt(madeForLine), input.lossEnabled);
      const remaining = pool.get(component.itemId) ?? new Decimal(0);
      pool.set(component.itemId, remaining.minus(used));
    }

    if (madeForLine < units) {
      for (const component of line.components) {
        if (component.dependencyClass !== "PRODUCTION_CRITICAL") continue;
        // requiredForUnits, not perUnitBase x units: the raw multiplication
        // ignored the loss policy and under-reported a real shortfall by 56%.
        const required = requiredForUnits(component, BigInt(units), input.lossEnabled);
        const found = shortage(input, component.itemId, required, pool);
        if (found && !productionBlockers.some((b) => b.itemId === found.itemId)) {
          productionBlockers.push(found);
        }
      }
    }
  }

  const productionStatus: ProductionReadiness =
    productionRequired === 0
      ? "READY_FROM_FINISHED"
      : makeableUnits >= productionRequired
        ? "MAKEABLE_BEFORE_DUE"
        : makeableUnits > 0
          ? "PARTIAL"
          : "BLOCKED_PRODUCTION";

  // Packing is assessed independently. A fulfillment shortage never reduces
  // production readiness, and an advisory shortage blocks neither.
  const fulfillmentBlockers: OrderShortage[] = [];
  const advisoryWarnings: OrderShortage[] = [];
  for (const packing of input.packingComponents) {
    const required = new Decimal(packing.perOrder);
    const found = shortage(input, packing.itemId, required);
    if (!found) continue;
    if (packing.dependencyClass === "FULFILLMENT_CRITICAL") fulfillmentBlockers.push(found);
    else if (packing.dependencyClass === "ADVISORY") advisoryWarnings.push(found);
    // PRODUCTION_CRITICAL in a packing rule is ignored on purpose: production
    // material is accounted for above, and counting it twice would double the
    // apparent requirement.
  }

  const fulfillmentStatus: FulfillmentReadiness =
    fulfillmentBlockers.length > 0
      ? "BLOCKED_FULFILLMENT_MATERIAL"
      : advisoryWarnings.length > 0
        ? "READY_WITH_ADVISORY_WARNINGS"
        : "READY";

  // Staleness is reported alongside every assessment, never inferred by the
  // caller. An offline number that looks live is worse than no number.
  const stale =
    minutesBetween(input.assessedAt, input.lastAuthoritativeSyncAt) >
    input.stalenessThresholdMinutes;

  return {
    orderId: input.orderId,
    finishedAllocated,
    productionRequired,
    makeableUnits,
    productionStatus,
    fulfillmentStatus,
    productionBlockers,
    fulfillmentBlockers,
    advisoryWarnings,
    stale,
    lastAuthoritativeSyncAt: input.lastAuthoritativeSyncAt,
  };
}
