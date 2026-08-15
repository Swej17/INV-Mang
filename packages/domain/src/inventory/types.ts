import type { Quantity } from "../units/types.js";

/**
 * Domain identities for physical stock.
 *
 * These describe what an item IS. What an item currently HOLDS is never stored
 * here — quantities are derived by summing ledger entries, so a projection can
 * always be rebuilt from history rather than trusted as its own source.
 */

export type ItemCategory =
  | "RAW_MATERIAL"
  | "COMPONENT"
  | "FINISHED_GOOD"
  | "PACKING_MATERIAL"
  | "SHIPPING_MATERIAL"
  | "MISCELLANEOUS";

/**
 * How a shortage of this item constrains the business.
 *
 * The distinction matters: a missing shipping box must never reduce the number
 * of candles the workshop can make, and an advisory item must never block
 * either stage.
 */
export type DependencyClass = "PRODUCTION_CRITICAL" | "FULFILLMENT_CRITICAL" | "ADVISORY";

export type InventoryItem = Readonly<{
  id: string;
  sku: string;
  name: string;
  description: string | null;
  active: boolean;
  category: ItemCategory;
  dependencyClass: DependencyClass;
  /** Everything is stored in this unit; display units are a presentation concern. */
  baseUnit: Quantity["unit"];
  displayPrecision: number;
  lotControlled: boolean;
  fifoEnabled: boolean;
  /** Held back from availability when the owner enables protection. */
  protectedQuantity: Quantity | null;
  squareVariationId: string | null;
  revision: string;
}>;

/**
 * A point-in-time projection derived from the ledger.
 *
 * `available` is deliberately not a stored column: it is a function of on-hand,
 * active reservations and protected stock, and recomputing it prevents the
 * three from drifting apart.
 */
export type InventoryProjection = Readonly<{
  itemId: string;
  locationId: string;
  onHand: Quantity;
  reserved: Quantity;
  incoming: Quantity;
  protectedQuantity: Quantity;
  revision: string;
}>;

export type LocationId = string;
export type OrganizationId = string;
