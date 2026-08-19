import { convertQuantity, type Quantity } from "@simple-flame/domain";
import type { InventoryCommand } from "@simple-flame/contracts";
import type { LedgerEntryDraft } from "@simple-flame/persistence-contracts";

/**
 * Turns a wire command into the ledger entries it means.
 *
 * Kept out of the route handler so the mapping is testable without a server,
 * and out of the domain so the domain stays free of wire concerns. Every branch
 * is explicit: an unhandled command type must fail loudly rather than silently
 * posting nothing, which would let a client believe a mutation landed when the
 * ledger never saw it.
 */

/** Quantities cross the wire in display units; the ledger stores base units. */
function toBase(quantity: Quantity): string {
  const base = quantity.unit === "EACH" || quantity.unit === "MILLILITER" ? quantity.unit : "GRAM";
  return convertQuantity(quantity, base).value;
}

export function translateCommand(command: InventoryCommand): readonly LedgerEntryDraft[] {
  const occurredAt = command.occurredAtLocal;

  switch (command.type) {
    case "inventory.receive":
      return [
        {
          itemId: command.payload.itemId,
          locationId: command.payload.locationId,
          cause: "RECEIPT",
          onHandDelta: toBase(command.payload.quantity),
          reservedDelta: "0",
          incomingDelta: "0",
          occurredAt,
          metadata: command.payload.lot ? { lot: command.payload.lot } : {},
        },
      ];

    case "inventory.adjust":
      return [
        {
          itemId: command.payload.itemId,
          locationId: command.payload.locationId,
          // The reason code is what distinguishes a recount from spoilage in
          // the audit trail; it is not decoration.
          cause:
            command.payload.reasonCode === "PHYSICAL_COUNT"
              ? "PHYSICAL_COUNT_ADJUSTMENT"
              : command.payload.reasonCode === "DAMAGE" ||
                  command.payload.reasonCode === "SPOILAGE"
                ? "DAMAGE_OR_SPOILAGE"
                : command.payload.reasonCode === "PROCESS_LOSS"
                  ? "PROCESS_LOSS"
                  : command.payload.reasonCode === "VENDOR_RETURN"
                    ? "VENDOR_RETURN"
                    : command.payload.reasonCode === "CUSTOMER_RETURN"
                      ? "CUSTOMER_RETURN"
                      : "SYNCHRONIZATION_CORRECTION",
          onHandDelta: toBase(command.payload.delta),
          reservedDelta: "0",
          incomingDelta: "0",
          occurredAt,
          metadata: { reasonCode: command.payload.reasonCode, note: command.payload.note },
        },
      ];

    case "order.reserve":
      return command.payload.lines.map((line) => ({
        itemId: line.finishedItemId,
        locationId: command.payload.locationId,
        cause: "ORDER_RESERVATION" as const,
        onHandDelta: "0",
        reservedDelta: String(line.units),
        incomingDelta: "0",
        occurredAt,
        metadata: { orderId: command.payload.orderId },
      }));

    case "order.release":
      // Release carries no lines: the caller supplies the reversal amounts via
      // a follow-up reserve command with negative units, so this records intent
      // only. Fully resolving a release needs the order's reservation history,
      // which arrives with Task 8's order state machine.
      throw new Error(
        "order.release requires reservation history and is not yet applied by the API",
      );

    case "production.complete":
      // Production is applied through CompleteProductionBatch, which needs the
      // recipe and lot repositories. Routing it here would duplicate that logic
      // and risk the two disagreeing.
      throw new Error(
        "production.complete must be submitted through the production endpoint, not sync push",
      );

    default: {
      // Exhaustiveness: a new command type added to the contract without a
      // mapping here becomes a compile error rather than a silent no-op.
      const unhandled: never = command;
      throw new Error(`unhandled command type: ${JSON.stringify(unhandled)}`);
    }
  }
}
