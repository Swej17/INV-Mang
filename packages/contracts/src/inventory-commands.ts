import { z } from "zod";

import { CommandEnvelope, DecimalString, QuantitySchema, Uuid } from "./common.js";

/**
 * Client-submitted mutations.
 *
 * There is deliberately NO command that sets an absolute quantity. Every
 * change is expressed as an intent the server evaluates against current state,
 * so two devices that both believed "there are 10" cannot silently overwrite
 * each other. Physical recounts go through `inventory.adjust`, which records
 * the counted value as a delta against what the server actually holds.
 */

const LotInput = z
  .object({
    supplierLotNumber: z.string().min(1).nullable(),
    internalLotCode: z.string().min(1).nullable(),
    receivedDate: z.iso.date(),
    bestByDate: z.iso.date().nullable(),
    unitCost: DecimalString.nullable(),
    notes: z.string().nullable(),
  })
  .nullable();

export const ReceivePayload = z.object({
  itemId: Uuid,
  locationId: Uuid,
  quantity: QuantitySchema,
  lot: LotInput,
});

export const AdjustPayload = z.object({
  itemId: Uuid,
  locationId: Uuid,
  /** Signed delta against server state, never an absolute replacement. */
  delta: QuantitySchema,
  reasonCode: z.enum([
    "PHYSICAL_COUNT",
    "DAMAGE",
    "SPOILAGE",
    "PROCESS_LOSS",
    "CORRECTION",
    "VENDOR_RETURN",
    "CUSTOMER_RETURN",
  ]),
  note: z.string().nullable(),
});

export const CompleteBatchPayload = z.object({
  batchId: Uuid,
  recipeVersionId: Uuid,
  locationId: Uuid,
  finishedItemId: Uuid,
  finishedUnits: z.int().positive(),
  /** Optional explicit lot overrides; omitted means FIFO proposal is accepted. */
  lotOverrides: z
    .array(z.object({ itemId: Uuid, lotId: Uuid, quantity: QuantitySchema }))
    .default([]),
});

export const ReserveOrderPayload = z.object({
  orderId: Uuid,
  locationId: Uuid,
  lines: z
    .array(z.object({ finishedItemId: Uuid, units: z.int().positive() }))
    .min(1, "an order reservation must cover at least one line"),
});

export const ReleaseOrderPayload = z.object({
  orderId: Uuid,
  locationId: Uuid,
  reason: z.enum(["CANCELLED", "REFUNDED", "FULFILLED", "SUPERSEDED"]),
});

export const InventoryCommandV1 = z.discriminatedUnion("type", [
  CommandEnvelope.extend({ type: z.literal("inventory.receive"), payload: ReceivePayload }),
  CommandEnvelope.extend({ type: z.literal("inventory.adjust"), payload: AdjustPayload }),
  CommandEnvelope.extend({ type: z.literal("production.complete"), payload: CompleteBatchPayload }),
  CommandEnvelope.extend({ type: z.literal("order.reserve"), payload: ReserveOrderPayload }),
  CommandEnvelope.extend({ type: z.literal("order.release"), payload: ReleaseOrderPayload }),
]);

export type InventoryCommand = z.infer<typeof InventoryCommandV1>;
export type InventoryCommandType = InventoryCommand["type"];
