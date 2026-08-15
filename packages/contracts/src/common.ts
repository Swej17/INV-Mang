import { CANONICAL_DECIMAL } from "@simple-flame/domain";
import { z } from "zod";

/**
 * Primitives every contract shares.
 *
 * The decimal grammar is imported from the domain rather than restated here.
 * Two copies of the rule would eventually disagree, and a quantity the API
 * accepted but the ledger rejected is the worst possible failure: the client
 * believes its command was durable when it was not.
 */

export const Uuid = z.uuid();

/** UTC instant. Local wall-clock time is carried separately and explicitly. */
export const IsoDateTime = z.iso.datetime();

/** Monotonic server revision, transported as a string to avoid 2^53 limits. */
export const Revision = z.string().regex(/^\d+$/, "revision must be a whole number");

export const DecimalString = z
  .string()
  .regex(CANONICAL_DECIMAL, "quantity must be a canonical base-10 decimal string");

export const BaseUnitSchema = z.enum(["GRAM", "EACH", "MILLILITER"]);
export const DisplayUnitSchema = z.enum(["GRAM", "EACH", "MILLILITER", "OUNCE", "POUND"]);

export const QuantitySchema = z.object({
  value: DecimalString,
  unit: DisplayUnitSchema,
});

/**
 * Every mutation carries the same envelope.
 *
 * `commandId` is the idempotency key: replaying it must return the original
 * result rather than posting a second ledger entry. `baseRevision` is what the
 * client believed when it composed the command, which is what makes optimistic
 * concurrency detectable instead of silently last-write-wins.
 */
export const CommandEnvelope = z.object({
  version: z.literal(1),
  commandId: Uuid,
  organizationId: Uuid,
  actorId: Uuid,
  deviceId: z.string().min(1),
  baseRevision: Revision,
  occurredAtLocal: IsoDateTime,
  queuedAt: IsoDateTime,
});

export type Quantity = z.infer<typeof QuantitySchema>;
export type CommandEnvelopeShape = z.infer<typeof CommandEnvelope>;
