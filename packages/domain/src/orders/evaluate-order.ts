import { Decimal, assertCanonicalDecimal } from "../units/convert.js";
import { calculateCapacity, type RecipeComponent } from "../capacity/calculate-capacity.js";
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
): OrderShortage | null {
  const available = assertCanonicalDecimal(input.availableByItem[itemId] ?? "0");
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
  let finishedAllocated = 0;
  let productionRequired = 0;
  for (const line of input.lines) {
    const onHand = Number(assertCanonicalDecimal(line.finishedAvailable).toFixed());
    const fromFinished = Math.min(line.orderedUnits, onHand);
    finishedAllocated += fromFinished;
    productionRequired += line.orderedUnits - fromFinished;
  }

  // Capacity for the remaining shortfall, using only production-critical
  // components. Shared materials across lines are approximated here by summing
  // requirements; a committed plan goes through allocateProduction.
  let makeableUnits = 0;
  const productionBlockers: OrderShortage[] = [];
  if (productionRequired > 0) {
    const first = input.lines.find((line) => line.orderedUnits > 0);
    if (first) {
      const capacity = calculateCapacity({
        recipeVersionId: first.recipeVersionId,
        components: first.components,
        availableByItem: input.availableByItem,
        ...(input.protectedByItem ? { protectedByItem: input.protectedByItem } : {}),
        lossEnabled: input.lossEnabled,
      });
      makeableUnits = Math.min(capacity.adjustedUnits, productionRequired);

      if (makeableUnits < productionRequired) {
        for (const component of first.components) {
          if (component.dependencyClass !== "PRODUCTION_CRITICAL") continue;
          const required = assertCanonicalDecimal(component.perUnitBase).times(productionRequired);
          const found = shortage(input, component.itemId, required);
          if (found) productionBlockers.push(found);
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
