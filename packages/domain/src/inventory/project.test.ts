import { describe, expect, it } from "vitest";

import { projectInventory, type LedgerEntryInput } from "./project.js";

const ITEM = "0199a1f0-0000-7000-8000-000000000004";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";

function entry(overrides: Partial<LedgerEntryInput>): LedgerEntryInput {
  return {
    eventId: "0199a1f0-0000-7000-8000-00000000000a",
    itemId: ITEM,
    locationId: LOCATION,
    cause: "RECEIPT",
    onHandDelta: "0",
    reservedDelta: "0",
    incomingDelta: "0",
    occurredAt: "2026-08-15T14:30:00.000Z",
    revision: "1",
    ...overrides,
  };
}

describe("projectInventory", () => {
  it("sums receipts into on-hand", () => {
    const projection = projectInventory([
      entry({ onHandDelta: "4535.9237" }),
      entry({ eventId: "b", onHandDelta: "453.59237", revision: "2" }),
    ]);
    expect(projection.onHand).toBe("4989.51607");
  });

  it("returns zeroes for an empty ledger rather than throwing", () => {
    const projection = projectInventory([]);
    expect(projection).toMatchObject({
      onHand: "0",
      reserved: "0",
      incoming: "0",
      available: "0",
    });
  });

  it("subtracts active reservations from available but not from on-hand", () => {
    const projection = projectInventory([
      entry({ onHandDelta: "100" }),
      entry({ eventId: "b", cause: "ORDER_RESERVATION", reservedDelta: "30", revision: "2" }),
    ]);
    expect(projection.onHand).toBe("100");
    expect(projection.reserved).toBe("30");
    expect(projection.available).toBe("70");
  });

  it("restores availability when a reservation is released", () => {
    const projection = projectInventory([
      entry({ onHandDelta: "100" }),
      entry({ eventId: "b", cause: "ORDER_RESERVATION", reservedDelta: "30", revision: "2" }),
      entry({ eventId: "c", cause: "RESERVATION_RELEASE", reservedDelta: "-30", revision: "3" }),
    ]);
    expect(projection.reserved).toBe("0");
    expect(projection.available).toBe("100");
  });

  it("subtracts protected stock from available", () => {
    const projection = projectInventory([entry({ onHandDelta: "100" })], {
      protectedQuantity: "25",
    });
    expect(projection.available).toBe("75");
  });

  it("never reports negative availability", () => {
    // Over-reservation is a data problem to surface, not a negative to display.
    const projection = projectInventory([
      entry({ onHandDelta: "10" }),
      entry({ eventId: "b", cause: "ORDER_RESERVATION", reservedDelta: "40", revision: "2" }),
    ]);
    expect(projection.available).toBe("0");
  });

  it("keeps incoming separate from available", () => {
    // An inbound purchase order must never inflate what can be promised today.
    const projection = projectInventory([
      entry({ onHandDelta: "10" }),
      entry({ eventId: "b", incomingDelta: "500", revision: "2" }),
    ]);
    expect(projection.incoming).toBe("500");
    expect(projection.available).toBe("10");
  });

  it("applies a compensating entry without editing history", () => {
    const projection = projectInventory([
      entry({ onHandDelta: "100" }),
      entry({
        eventId: "b",
        cause: "ADMINISTRATIVE_REVERSAL",
        onHandDelta: "-100",
        compensatesEventId: "0199a1f0-0000-7000-8000-00000000000a",
        revision: "2",
      }),
    ]);
    expect(projection.onHand).toBe("0");
    expect(projection.entryCount).toBe(2);
  });

  it("reports the highest revision it has seen", () => {
    const projection = projectInventory([
      entry({ revision: "7" }),
      entry({ eventId: "b", revision: "9" }),
      entry({ eventId: "c", revision: "8" }),
    ]);
    expect(projection.revision).toBe("9");
  });

  it("is order independent for the resulting totals", () => {
    const forward = projectInventory([
      entry({ onHandDelta: "100" }),
      entry({ eventId: "b", cause: "ORDER_RESERVATION", reservedDelta: "30", revision: "2" }),
    ]);
    const reverse = projectInventory([
      entry({ eventId: "b", cause: "ORDER_RESERVATION", reservedDelta: "30", revision: "2" }),
      entry({ onHandDelta: "100" }),
    ]);
    expect(forward.onHand).toBe(reverse.onHand);
    expect(forward.available).toBe(reverse.available);
  });

  it("does not lose precision across many small entries", () => {
    // 0.1 x 10 must be exactly 1, not 0.9999999999999999.
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ eventId: `e${index}`, onHandDelta: "0.1", revision: String(index + 1) }),
    );
    expect(projectInventory(entries).onHand).toBe("1");
  });

  it("rejects a non-canonical delta rather than coercing it", () => {
    expect(() => projectInventory([entry({ onHandDelta: "1e3" })])).toThrow("invalid quantity");
  });
});
