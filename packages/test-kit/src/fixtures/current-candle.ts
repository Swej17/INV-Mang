import { convertQuantity } from "@simple-flame/domain";

/**
 * The Simple Flame 17 oz candle, exactly as the design document specifies.
 *
 * This is a PERMANENT fixture, not a convenience for one test. It is the real
 * recipe the business runs on, so if a refactor changes what these numbers
 * produce, that is a production incident caught early rather than a test to
 * update.
 *
 * Wax 15.7 oz + fragrance 1.3 oz = 17 oz fill, plus one each of vessel, lid,
 * circular label, rectangular scent label and wooden wick.
 */

export const GOLDEN_WAX_ID = "0199a200-0000-7000-8000-000000000001";
export const FRAGRANCE_ID = "0199a200-0000-7000-8000-000000000002";
export const VESSEL_ID = "0199a200-0000-7000-8000-000000000003";
export const LID_ID = "0199a200-0000-7000-8000-000000000004";
export const CIRCULAR_LABEL_ID = "0199a200-0000-7000-8000-000000000005";
export const SCENT_LABEL_ID = "0199a200-0000-7000-8000-000000000006";
export const WOODEN_WICK_ID = "0199a200-0000-7000-8000-000000000007";
export const SHIPPING_BOX_ID = "0199a200-0000-7000-8000-000000000008";
export const RECIPE_VERSION_ID = "0199a200-0000-7000-8000-0000000000a1";
export const FINISHED_CANDLE_ID = "0199a200-0000-7000-8000-0000000000b1";

/**
 * Ounces expressed in grams, the base unit the ledger stores.
 * Delegates to the domain's converter rather than restating the arithmetic.
 */
export function ounceInGrams(ounces: string): string {
  return convertQuantity({ value: ounces, unit: "OUNCE" }, "GRAM").value;
}

export const CURRENT_CANDLE_COMPONENTS = [
  { itemId: GOLDEN_WAX_ID, name: "Golden Brands 464 soy wax", perUnitOunces: "15.7" },
  { itemId: FRAGRANCE_ID, name: "Fragrance oil", perUnitOunces: "1.3" },
] as const;

export const CURRENT_CANDLE_COUNTABLES = [
  { itemId: VESSEL_ID, name: "Vessel" },
  { itemId: LID_ID, name: "Lid" },
  { itemId: CIRCULAR_LABEL_ID, name: "Circular label" },
  { itemId: SCENT_LABEL_ID, name: "Rectangular scent label" },
  { itemId: WOODEN_WICK_ID, name: "Wooden wick" },
] as const;
