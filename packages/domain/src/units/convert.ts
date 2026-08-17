import { Decimal as BaseDecimal } from "decimal.js";

import {
  type DisplayUnit,
  type Quantity,
  GRAMS_PER_MASS_UNIT,
  dimensionOf,
} from "./types.js";

/**
 * A local Decimal with headroom well beyond any quantity we store, so that a
 * non-terminating division (gram -> ounce) cannot accumulate visible drift.
 * Cloned rather than configured globally: mutating the shared Decimal config
 * would silently change behaviour for every other consumer of decimal.js.
 */
const Decimal = BaseDecimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40 });

/**
 * The only quantity spelling this system accepts.
 *
 * Deliberately narrower than what decimal.js will parse. Left to itself
 * decimal.js accepts radix prefixes, exponent notation and a leading plus, so
 * "0xff" would become 255 and "1e3" would become 1000 — a malformed external
 * string silently turning into a materially different ledger quantity. A
 * quantity must be rejected at the boundary, not reinterpreted.
 *
 * Permits an optional sign, no leading zeroes beyond "0" itself, and any
 * number of fractional digits (so "1.500" still normalises to "1.5").
 */
export const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Reject anything that is not a canonical base-10 decimal literal.
 *
 * Exported so every layer that handles a raw quantity string — conversion,
 * ledger projection, persistence — validates through one implementation. A
 * second copy of this check would eventually disagree with this one.
 */
export function assertCanonicalDecimal(value: string): InstanceType<typeof Decimal> {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new Error(`invalid quantity: ${value}`);
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) {
    throw new Error(`invalid quantity: ${value}`);
  }
  return parsed;
}

/**
 * Reject a value that must never be negative.
 *
 * `assertCanonicalDecimal` permits a leading sign because ledger DELTAS are
 * legitimately negative — a consumption reduces on-hand. But most quantities in
 * this system are magnitudes, and a negative one inverts the rule it feeds:
 *
 *   negative protected stock  -> protection INCREASES capacity
 *   negative loss percentage  -> loss INCREASES capacity
 *   negative available        -> the planner conjures material that never existed
 *
 * Each of those silently breaks an invariant the design document calls
 * critical, so magnitudes are validated at their boundary rather than trusted.
 */
export function assertNonNegativeDecimal(
  value: string,
  label: string,
): InstanceType<typeof Decimal> {
  const parsed = assertCanonicalDecimal(value);
  if (parsed.isNegative()) {
    throw new Error(`${label} must not be negative, received ${value}`);
  }
  return parsed;
}

const parse = assertCanonicalDecimal;

/**
 * Render without exponent notation and without trailing zeroes, so that the
 * same magnitude always serialises to the same string. `toFixed()` with no
 * argument never switches to exponential form.
 */
function render(amount: InstanceType<typeof Decimal>): string {
  return amount.toFixed();
}

function assertCountIsIntegral(amount: InstanceType<typeof Decimal>): void {
  if (!amount.isInteger()) {
    throw new Error(`countable quantity must be an integer: ${render(amount)}`);
  }
}

/**
 * Convert between units of the SAME dimension. Mass never becomes count and
 * volume never becomes mass: a density conversion is a business decision that
 * belongs in a recipe, not an implicit unit cast.
 */
export function convertQuantity(input: Quantity, target: DisplayUnit): Quantity {
  const sourceDimension = dimensionOf(input.unit);
  const targetDimension = dimensionOf(target);

  if (sourceDimension !== targetDimension) {
    throw new Error(
      `incompatible dimensions: cannot convert ${input.unit} (${sourceDimension}) to ${target} (${targetDimension})`,
    );
  }

  const amount = parse(input.value);

  if (sourceDimension === "COUNT") {
    assertCountIsIntegral(amount);
    return { value: render(amount), unit: target };
  }

  // Identity short-circuit: avoids a multiply/divide round trip that could
  // introduce a rounding artefact into a value that needs no conversion.
  if (input.unit === target) {
    return { value: render(amount), unit: target };
  }

  if (sourceDimension === "VOLUME") {
    // MILLILITER is currently the only volume unit, so a non-identity volume
    // conversion means an unknown unit reached this far.
    throw new Error(`incompatible dimensions: no volume conversion from ${input.unit} to ${target}`);
  }

  const fromGrams = GRAMS_PER_MASS_UNIT[input.unit as keyof typeof GRAMS_PER_MASS_UNIT];
  const toGrams = GRAMS_PER_MASS_UNIT[target as keyof typeof GRAMS_PER_MASS_UNIT];

  const converted = amount.times(new Decimal(fromGrams)).dividedBy(new Decimal(toGrams));
  return { value: render(converted), unit: target };
}

/** Internal helper shared with quantity.ts. */
export function toDecimal(input: Quantity, target: DisplayUnit): InstanceType<typeof Decimal> {
  return new Decimal(convertQuantity(input, target).value);
}

export { Decimal };
