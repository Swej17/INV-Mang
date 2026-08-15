/**
 * Canonical unit vocabulary.
 *
 * Quantities cross every boundary as decimal STRINGS, never as JavaScript
 * numbers: binary floating point cannot represent values like 0.1 exactly, and
 * an inventory ledger that drifts is worse than one that refuses to compute.
 */

/** Units a quantity is stored in internally. */
export type BaseUnit = "GRAM" | "EACH" | "MILLILITER";

/** Units a quantity may be expressed in, including display-only mass units. */
export type DisplayUnit = BaseUnit | "OUNCE" | "POUND";

/** What a unit measures. Conversion is only ever legal within one dimension. */
export type Dimension = "MASS" | "COUNT" | "VOLUME";

export type Quantity<U extends DisplayUnit = DisplayUnit> = Readonly<{
  value: string;
  unit: U;
}>;

const DIMENSIONS: Readonly<Record<DisplayUnit, Dimension>> = {
  GRAM: "MASS",
  OUNCE: "MASS",
  POUND: "MASS",
  EACH: "COUNT",
  MILLILITER: "VOLUME",
};

/** The base unit every quantity of a dimension is normalised to. */
const BASE_UNITS: Readonly<Record<Dimension, BaseUnit>> = {
  MASS: "GRAM",
  COUNT: "EACH",
  VOLUME: "MILLILITER",
};

export function dimensionOf(unit: DisplayUnit): Dimension {
  return DIMENSIONS[unit];
}

export function baseUnitOf(dimension: Dimension): BaseUnit {
  return BASE_UNITS[dimension];
}

/**
 * Exact grams per unit. These are definitions, not measurements:
 * one pound is exactly 453.59237 g, one ounce exactly one sixteenth of that.
 */
export const GRAMS_PER_MASS_UNIT: Readonly<Record<"GRAM" | "OUNCE" | "POUND", string>> = {
  GRAM: "1",
  OUNCE: "28.349523125",
  POUND: "453.59237",
};
