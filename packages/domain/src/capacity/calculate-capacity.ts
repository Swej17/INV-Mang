import { Decimal, assertNonNegativeDecimal } from "../units/convert.js";
import type { DependencyClass } from "../inventory/types.js";

/**
 * How many candles can be made from what is on hand.
 *
 * Two numbers are always produced and never conflated. THEORETICAL ignores
 * protected stock and process loss — it answers "what does the raw material
 * allow". ADJUSTED applies every enabled rule — it answers "what can I
 * actually commit to". Reporting only one of them is how an operator ends up
 * promising stock they cannot produce.
 */

export type LossPolicy =
  | { mode: "NONE" }
  | { mode: "PERCENT_PER_UNIT"; percentage: string }
  | { mode: "FIXED_PER_BATCH"; fixedPerBatchBase: string; batchSize: number }
  | {
      mode: "BOTH";
      percentage: string;
      fixedPerBatchBase: string;
      batchSize: number;
    };

export type RecipeComponent = Readonly<{
  itemId: string;
  /** Quantity per finished unit, in the item's base unit. */
  perUnitBase: string;
  dependencyClass: DependencyClass;
  loss: LossPolicy;
  /** Countable items must consume whole numbers. */
  countable: boolean;
}>;

export type CapacityInput = Readonly<{
  recipeVersionId: string;
  components: readonly RecipeComponent[];
  availableByItem: Readonly<Record<string, string>>;
  protectedByItem?: Readonly<Record<string, string>>;
  /** Loss rules are configured but inert until the owner switches them on. */
  lossEnabled: boolean;
}>;

export type ComponentShortfall = Readonly<{
  itemId: string;
  required: string;
  available: string;
  shortfall: string;
}>;

export type CapacityResult = Readonly<{
  recipeVersionId: string;
  /** Ignores protection and loss. */
  theoreticalUnits: number;
  /** Applies every enabled protection and loss rule. */
  adjustedUnits: number;
  /** Components that pin adjustedUnits. Ties are all reported. */
  limitingItemIds: readonly string[];
  /** What making one more unit would additionally require. */
  shortfallForOneMore: readonly ComponentShortfall[];
  /**
   * Always true. Shared materials are not reserved by this calculation, so two
   * products can each be told they could use the same wax. Only an allocated
   * plan (Task 6) resolves that, and callers must not present this as committed.
   */
  hypothetical: true;
}>;

/**
 * Material required to produce `units` of a component.
 *
 * required(n) = n x perUnit x (1 + percentage) + ceil(n / batchSize) x fixedPerBatch
 */
export function requiredForUnits(
  component: RecipeComponent,
  units: bigint,
  lossEnabled: boolean,
): InstanceType<typeof Decimal> {
  const perUnit = assertNonNegativeDecimal(component.perUnitBase, `perUnitBase for ${component.itemId}`);
  if (perUnit.isZero()) {
    // An item that consumes nothing is a data error, and it also makes the
    // capacity search unbounded: every unit count "fits".
    throw new Error(`perUnitBase for ${component.itemId} must be greater than zero`);
  }
  const count = new Decimal(units.toString());
  let required = perUnit.times(count);

  if (!lossEnabled || component.loss.mode === "NONE") return required;

  const loss = component.loss;
  if (loss.mode === "PERCENT_PER_UNIT" || loss.mode === "BOTH") {
    required = required.times(
      new Decimal(1).plus(assertNonNegativeDecimal(loss.percentage, "loss.percentage")),
    );
  }
  if (loss.mode === "FIXED_PER_BATCH" || loss.mode === "BOTH") {
    if (!Number.isInteger(loss.batchSize) || loss.batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer for ${component.itemId}`);
    }
    // ceil, not round: a partial batch still incurs the whole batch loss.
    const batches = count.dividedBy(loss.batchSize).ceil();
    required = required.plus(
      batches.times(assertNonNegativeDecimal(loss.fixedPerBatchBase, "loss.fixedPerBatchBase")),
    );
  }
  return required;
}

/**
 * Largest whole `units` this component can support.
 *
 * Deliberately a search rather than `available / perUnit`. Fixed batch loss
 * makes requirement a step function, so division overestimates near a batch
 * boundary. Exponential growth to bracket the answer, then binary search.
 */
function maxUnitsFor(
  component: RecipeComponent,
  available: InstanceType<typeof Decimal>,
  lossEnabled: boolean,
): bigint {
  if (available.lessThanOrEqualTo(0)) return 0n;
  if (requiredForUnits(component, 1n, lossEnabled).greaterThan(available)) return 0n;

  let upper = 1n;
  // Cap the bracket so a component with a zero per-unit cost cannot loop
  // forever; 2^40 units is far beyond any real production plan.
  while (
    upper < 1n << 40n &&
    requiredForUnits(component, upper * 2n, lossEnabled).lessThanOrEqualTo(available)
  ) {
    upper *= 2n;
  }

  let low = upper;
  let high = upper * 2n;
  while (low + 1n < high) {
    const mid = (low + high) / 2n;
    if (requiredForUnits(component, mid, lossEnabled).lessThanOrEqualTo(available)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function availableFor(
  input: CapacityInput,
  itemId: string,
  applyProtection: boolean,
): InstanceType<typeof Decimal> {
  // An item with no entry is absent, not unlimited. Treating a missing key as
  // infinite would silently promise material nobody has.
  const raw = input.availableByItem[itemId] ?? "0";
  let available = assertNonNegativeDecimal(raw, `availableByItem[${itemId}]`);
  if (applyProtection) {
    const held = input.protectedByItem?.[itemId];
    if (held !== undefined) {
      available = available.minus(assertNonNegativeDecimal(held, `protectedByItem[${itemId}]`));
    }
  }
  return available.isNegative() ? new Decimal(0) : available;
}

export function calculateCapacity(input: CapacityInput): CapacityResult {
  // Only production-critical components constrain making candles. A missing
  // shipping box blocks shipping, never production; advisory items block
  // neither.
  const critical = input.components.filter(
    (component) => component.dependencyClass === "PRODUCTION_CRITICAL",
  );
  if (critical.length === 0) {
    throw new Error("no production-critical components: capacity is undefined for this recipe");
  }

  const theoreticalPerComponent = critical.map((component) => ({
    component,
    units: maxUnitsFor(component, availableFor(input, component.itemId, false), false),
  }));
  const adjustedPerComponent = critical.map((component) => ({
    component,
    units: maxUnitsFor(component, availableFor(input, component.itemId, true), input.lossEnabled),
  }));

  const theoreticalUnits = theoreticalPerComponent.reduce(
    (lowest, entry) => (entry.units < lowest ? entry.units : lowest),
    theoreticalPerComponent[0]!.units,
  );
  const adjustedUnits = adjustedPerComponent.reduce(
    (lowest, entry) => (entry.units < lowest ? entry.units : lowest),
    adjustedPerComponent[0]!.units,
  );

  // Every component sitting at the minimum is a limit, not just the first one
  // found: telling the owner to buy wax when vessels are equally short would
  // send them shopping twice.
  const limitingItemIds = adjustedPerComponent
    .filter((entry) => entry.units === adjustedUnits)
    .map((entry) => entry.component.itemId);

  const oneMore = adjustedUnits + 1n;
  const shortfallForOneMore: ComponentShortfall[] = [];
  for (const component of critical) {
    const available = availableFor(input, component.itemId, true);
    const required = requiredForUnits(component, oneMore, input.lossEnabled);
    if (required.greaterThan(available)) {
      shortfallForOneMore.push({
        itemId: component.itemId,
        required: required.toFixed(),
        available: available.toFixed(),
        shortfall: required.minus(available).toFixed(),
      });
    }
  }

  return {
    recipeVersionId: input.recipeVersionId,
    theoreticalUnits: Number(theoreticalUnits),
    adjustedUnits: Number(adjustedUnits),
    limitingItemIds,
    shortfallForOneMore,
    hypothetical: true,
  };
}
