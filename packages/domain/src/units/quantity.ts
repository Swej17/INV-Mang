import { convertQuantity, toDecimal } from "./convert.js";
import { type DisplayUnit, type Quantity, baseUnitOf, dimensionOf } from "./types.js";

/**
 * Add two quantities and express the sum in `target`.
 *
 * Both operands are converted before adding, so mixing ounces and pounds is
 * safe while mixing eaches and grams throws rather than silently coercing.
 */
export function addQuantity(a: Quantity, b: Quantity, target: DisplayUnit): Quantity {
  const sum = toDecimal(a, target).plus(toDecimal(b, target));
  // Round-trip through convertQuantity so COUNT integrality and string
  // normalisation are enforced in exactly one place.
  return convertQuantity({ value: sum.toFixed(), unit: target }, target);
}

/**
 * Order two quantities by magnitude, comparing at full stored precision.
 *
 * Comparison happens in the dimension's base unit so that equal magnitudes
 * expressed differently (1 POUND vs 453.59237 GRAM) compare equal, and
 * display rounding never decides the outcome.
 */
export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const dimension = dimensionOf(a.unit);
  if (dimension !== dimensionOf(b.unit)) {
    throw new Error(
      `incompatible dimensions: cannot compare ${a.unit} (${dimension}) to ${b.unit} (${dimensionOf(b.unit)})`,
    );
  }

  const base = baseUnitOf(dimension);
  const comparison = toDecimal(a, base).comparedTo(toDecimal(b, base));

  if (comparison === null) {
    throw new Error("invalid quantity: comparison is undefined");
  }
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}
