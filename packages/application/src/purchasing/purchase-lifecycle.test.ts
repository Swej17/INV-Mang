import { beforeEach, describe, expect, it } from "vitest";

import type {
  AppendResult,
  InventoryLedgerRepository,
  LedgerEntryDraft,
  LedgerEntryRecord,
  ProjectionRecord,
} from "@simple-flame/persistence-contracts";

import { PurchaseLifecycle } from "./purchase-lifecycle.js";

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const WAX = "0199a200-0000-7000-8000-000000000001";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";
const PO = "0199a700-0000-7000-8000-000000000010";

class FakeLedger implements InventoryLedgerRepository {
  appended: { commandId: string; entries: readonly LedgerEntryDraft[] }[] = [];
  async appendOnce(
    commandId: string,
    _org: string,
    entries: readonly LedgerEntryDraft[],
  ): Promise<AppendResult> {
    this.appended.push({ commandId, entries });
    return { revision: String(this.appended.length), duplicate: false, entries: [] };
  }
  async releaseOrder(): Promise<AppendResult> {
    throw new Error("not used");
  }
  async getProjection(): Promise<ProjectionRecord> {
    throw new Error("not used");
  }
  async listEntries(): Promise<readonly LedgerEntryRecord[]> {
    return [];
  }
}

let ledger: FakeLedger;
let lifecycle: PurchaseLifecycle;

beforeEach(() => {
  ledger = new FakeLedger();
  lifecycle = new PurchaseLifecycle({ ledger, clock: { now: () => "2026-08-16T12:00:00.000Z" } });
});

describe("markOrdered", () => {
  const base = {
    commandId: "0199a700-0000-7000-8000-0000000000c1",
    organizationId: ORG,
    purchaseOrderId: PO,
    itemId: WAX,
    locationId: LOCATION,
    orderedQuantity: "3",
    packConversion: "4535.9237",
    expectedArrival: "2026-08-23",
  };

  it("moves incoming and leaves on-hand untouched", async () => {
    await lifecycle.markOrdered(base);
    const entry = ledger.appended[0]!.entries[0]!;
    // Inbound stock must never make an order look shippable today.
    expect(entry.onHandDelta).toBe("0");
    expect(entry.incomingDelta).toBe("13607.7711");
  });

  it("converts purchase units to base units", async () => {
    await lifecycle.markOrdered({ ...base, orderedQuantity: "1" });
    expect(ledger.appended[0]!.entries[0]!.incomingDelta).toBe("4535.9237");
  });

  it("records the purchase order for traceability", async () => {
    await lifecycle.markOrdered(base);
    expect(ledger.appended[0]!.entries[0]!.metadata).toMatchObject({
      purchaseOrderId: PO,
    });
  });

  it("posts a purchase cause, not a synchronization correction", async () => {
    // The cause is the audit trail's own vocabulary. Filing a purchase under
    // SYNCHRONIZATION_CORRECTION made every order look like a sync repair, so a
    // genuine repair — the thing you most want to find when numbers disagree —
    // became indistinguishable from routine buying.
    await lifecycle.markOrdered(base);
    expect(ledger.appended[0]!.entries[0]!.cause).toBe("PURCHASE_ORDERED");
  });

  it("distinguishes an expected inbound from stock actually received", async () => {
    // Both halves of the lifecycle touch incoming; only one of them is real
    // stock. Sharing a cause would make "ordered" and "arrived" the same event.
    await lifecycle.markOrdered(base);
    await lifecycle.receive({
      commandId: "0199a700-0000-7000-8000-0000000000c2",
      organizationId: ORG,
      purchaseOrderId: PO,
      itemId: WAX,
      locationId: LOCATION,
      receivedBaseQuantity: "100",
      outstandingBaseQuantity: "100",
    });
    const causes = ledger.appended.map((call) => call.entries[0]!.cause);
    expect(causes).toEqual(["PURCHASE_ORDERED", "RECEIPT"]);
  });

  it("uses the caller's commandId so a retry is idempotent", async () => {
    await lifecycle.markOrdered(base);
    expect(ledger.appended[0]!.commandId).toBe(base.commandId);
  });

  it.each([["0"], ["-1"]])("refuses an ordered quantity of %s", async (orderedQuantity) => {
    await expect(lifecycle.markOrdered({ ...base, orderedQuantity })).rejects.toThrow();
    expect(ledger.appended).toHaveLength(0);
  });

  it("refuses a zero pack conversion", async () => {
    await expect(lifecycle.markOrdered({ ...base, packConversion: "0" })).rejects.toThrow(
      "greater than zero",
    );
  });
});

describe("receive", () => {
  const base = {
    commandId: "0199a700-0000-7000-8000-0000000000c2",
    organizationId: ORG,
    purchaseOrderId: PO,
    itemId: WAX,
    locationId: LOCATION,
    receivedBaseQuantity: "13607.7711",
    outstandingBaseQuantity: "13607.7711",
  };

  it("raises on-hand and clears the expectation in one command", async () => {
    await lifecycle.receive(base);
    // One command: no window where stock counts as both incoming and on-hand.
    expect(ledger.appended).toHaveLength(1);
    const entry = ledger.appended[0]!.entries[0]!;
    expect(entry.onHandDelta).toBe("13607.7711");
    expect(entry.incomingDelta).toBe("-13607.7711");
  });

  it("leaves the remainder outstanding on a short delivery", async () => {
    await lifecycle.receive({ ...base, receivedBaseQuantity: "4535.9237" });
    const entry = ledger.appended[0]!.entries[0]!;
    expect(entry.onHandDelta).toBe("4535.9237");
    // Only what arrived clears; the rest is still expected.
    expect(entry.incomingDelta).toBe("-4535.9237");
  });

  it("does not clear more than was outstanding on an over-delivery", async () => {
    await lifecycle.receive({
      ...base,
      receivedBaseQuantity: "20000",
      outstandingBaseQuantity: "13607.7711",
    });
    const entry = ledger.appended[0]!.entries[0]!;
    expect(entry.onHandDelta).toBe("20000");
    // Clearing more would drive incoming negative on an unrelated order.
    expect(entry.incomingDelta).toBe("-13607.7711");
  });

  it("records lot details when supplied", async () => {
    await lifecycle.receive({
      ...base,
      lot: {
        lotId: "0199a700-0000-7000-8000-0000000000d1",
        supplierLotNumber: "GB464-2208",
        receivedDate: "2026-08-16",
        bestByDate: "2028-08-16",
        unitCost: "42.50",
      },
    });
    expect(ledger.appended[0]!.entries[0]!.metadata).toMatchObject({ kind: "PURCHASE_RECEIVED" });
  });

  it("posts a RECEIPT cause", async () => {
    await lifecycle.receive(base);
    expect(ledger.appended[0]!.entries[0]!.cause).toBe("RECEIPT");
  });

  it.each([["0"], ["-5"]])("refuses a received quantity of %s", async (receivedBaseQuantity) => {
    await expect(lifecycle.receive({ ...base, receivedBaseQuantity })).rejects.toThrow();
    expect(ledger.appended).toHaveLength(0);
  });
});
