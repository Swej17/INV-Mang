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

/** Reject anything that is not a finite decimal literal before doing math. */
function parse(value: string): InstanceType<typeof Decimal> {
  let parsed: InstanceType<typeof Decimal>;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new Error(`invalid quantity: ${value}`);
  }
  if (!parsed.isFinite()) {
    throw new Error(`invalid quantity: ${value}`);
  }
  return parsed;
}

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
