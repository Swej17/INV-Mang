import { describe, expect, it } from "vitest";

import { CONFLICT_CODES, InventoryCommandV1, InventoryEventV1, SyncPushRequestV1, SyncPushResultV1 } from "./index.js";

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const ACTOR = "0199a1f0-0000-7000-8000-000000000002";
const COMMAND = "0199a1f0-0000-7000-8000-000000000003";
const ITEM = "0199a1f0-0000-7000-8000-000000000004";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";

function baseCommand() {
  return {
    version: 1 as const,
    commandId: COMMAND,
    organizationId: ORG,
    actorId: ACTOR,
    deviceId: "workshop-laptop",
    baseRevision: "42",
    occurredAtLocal: "2026-08-15T14:30:00.000Z",
    queuedAt: "2026-08-15T14:30:01.000Z",
  };
}

function receiveStockFixture() {
  return {
    ...baseCommand(),
    type: "inventory.receive" as const,
    payload: {
      itemId: ITEM,
      locationId: LOCATION,
      quantity: { value: "4535.9237", unit: "GRAM" as const },
      lot: null,
    },
  };
}

describe("InventoryCommandV1", () => {
  it("accepts a versioned receive-stock command", () => {
    expect(InventoryCommandV1.parse(receiveStockFixture()).type).toBe("inventory.receive");
  });

  it("rejects unrecognized absolute quantity mutation", () => {
    expect(() =>
      InventoryCommandV1.parse({ ...baseCommand(), type: "inventory.setQuantity", quantity: "10" }),
    ).toThrow();
  });

  it("exposes no command type that sets an absolute quantity", () => {
    // The ledger is append-only; a setQuantity path would let a client
    // overwrite derived state and silently destroy history.
    const types = InventoryCommandV1.options.map(
      (option) => option.shape.type.value as string,
    );
    expect(types.some((type) => /set|overwrite|replace/i.test(type))).toBe(false);
  });

  it.each([
    ["inventory.receive"],
    ["inventory.adjust"],
    ["production.complete"],
    ["order.reserve"],
    ["order.release"],
  ])("carries the %s type in the union", (type) => {
    const types = InventoryCommandV1.options.map((option) => option.shape.type.value as string);
    expect(types).toContain(type);
  });

  describe("envelope invariants", () => {
    it.each([
      ["commandId", "not-a-uuid"],
      ["organizationId", "not-a-uuid"],
      ["actorId", "not-a-uuid"],
    ])("rejects a non-uuid %s", (field, value) => {
      expect(() =>
        InventoryCommandV1.parse({ ...receiveStockFixture(), [field]: value }),
      ).toThrow();
    });

    it("rejects an empty deviceId", () => {
      expect(() => InventoryCommandV1.parse({ ...receiveStockFixture(), deviceId: "" })).toThrow();
    });

    it("rejects a non-numeric baseRevision", () => {
      expect(() =>
        InventoryCommandV1.parse({ ...receiveStockFixture(), baseRevision: "forty-two" }),
      ).toThrow();
    });

    it("rejects a non-ISO occurredAtLocal", () => {
      expect(() =>
        InventoryCommandV1.parse({ ...receiveStockFixture(), occurredAtLocal: "15/08/2026" }),
      ).toThrow();
    });

    it("rejects a future protocol version", () => {
      expect(() => InventoryCommandV1.parse({ ...receiveStockFixture(), version: 2 })).toThrow();
    });

    it("requires the idempotency key", () => {
      const withoutCommandId: Record<string, unknown> = { ...receiveStockFixture() };
      delete withoutCommandId["commandId"];
      expect(() => InventoryCommandV1.parse(withoutCommandId)).toThrow();
    });
  });

  describe("quantity payloads use the canonical decimal grammar", () => {
    // Must match packages/domain exactly, or a value the API accepts could be
    // rejected downstream by the ledger.
    it.each([["0xff"], ["1e3"], ["+1"], [" 1"], ["NaN"], ["Infinity"], [".5"], ["01"]])(
      "rejects the non-canonical quantity %s",
      (value) => {
        const command = receiveStockFixture();
        expect(() =>
          InventoryCommandV1.parse({
            ...command,
            payload: { ...command.payload, quantity: { value, unit: "GRAM" } },
          }),
        ).toThrow();
      },
    );

    it.each([["0"], ["1.500"], ["-1.5"], ["9999999999999999.99999999"]])(
      "accepts the canonical quantity %s",
      (value) => {
        const command = receiveStockFixture();
        expect(() =>
          InventoryCommandV1.parse({
            ...command,
            payload: { ...command.payload, quantity: { value, unit: "GRAM" } },
          }),
        ).not.toThrow();
      },
    );
  });
});

describe("InventoryEventV1", () => {
  it("accepts a receipt ledger event", () => {
    const event = InventoryEventV1.parse({
      version: 1,
      eventId: "0199a1f0-0000-7000-8000-00000000000a",
      commandId: COMMAND,
      organizationId: ORG,
      locationId: LOCATION,
      itemId: ITEM,
      cause: "RECEIPT",
      onHandDelta: "4535.9237",
      reservedDelta: "0",
      incomingDelta: "0",
      occurredAt: "2026-08-15T14:30:00.000Z",
      revision: "43",
    });
    expect(event.cause).toBe("RECEIPT");
  });

  it("rejects an unknown ledger cause", () => {
    expect(() =>
      InventoryEventV1.parse({
        version: 1,
        eventId: "0199a1f0-0000-7000-8000-00000000000a",
        commandId: COMMAND,
        organizationId: ORG,
        locationId: LOCATION,
        itemId: ITEM,
        cause: "SHRINKAGE_MAYBE",
        onHandDelta: "1",
        reservedDelta: "0",
        incomingDelta: "0",
        occurredAt: "2026-08-15T14:30:00.000Z",
        revision: "43",
      }),
    ).toThrow();
  });

  it("carries every cause the design document names", () => {
    const causes = InventoryEventV1.shape.cause.options as readonly string[];
    for (const required of [
      "RECEIPT",
      "PURCHASE_ORDERED",
      "PHYSICAL_COUNT_ADJUSTMENT",
      "DAMAGE_OR_SPOILAGE",
      "PRODUCTION_ALLOCATION",
      "PRODUCTION_CONSUMPTION",
      "PRODUCTION_OUTPUT",
      "ORDER_RESERVATION",
      "RESERVATION_RELEASE",
      "FULFILLMENT_CONSUMPTION",
      "CUSTOMER_RETURN",
      "VENDOR_RETURN",
      "PROCESS_LOSS",
      "SYNCHRONIZATION_CORRECTION",
      "ADMINISTRATIVE_REVERSAL",
    ]) {
      expect(causes).toContain(required);
    }
  });
});

describe("sync contracts", () => {
  it("accepts a push carrying commands in local order", () => {
    const request = SyncPushRequestV1.parse({
      version: 1,
      deviceId: "workshop-laptop",
      knownRevision: "42",
      commands: [receiveStockFixture()],
    });
    expect(request.commands).toHaveLength(1);
  });

  it("rejects a push with no commands", () => {
    expect(() =>
      SyncPushRequestV1.parse({
        version: 1,
        deviceId: "workshop-laptop",
        knownRevision: "42",
        commands: [],
      }),
    ).toThrow();
  });

  it("returns the original result shape for an accepted command", () => {
    const result = SyncPushResultV1.parse({
      version: 1,
      serverRevision: "43",
      accepted: [{ commandId: COMMAND, revision: "43", duplicate: false }],
      conflicts: [],
    });
    expect(result.accepted[0]?.duplicate).toBe(false);
  });

  it("marks a replayed command as a duplicate rather than reposting it", () => {
    const result = SyncPushResultV1.parse({
      version: 1,
      serverRevision: "43",
      accepted: [{ commandId: COMMAND, revision: "43", duplicate: true }],
      conflicts: [],
    });
    expect(result.accepted[0]?.duplicate).toBe(true);
  });

  it.each([
    ["REVISION_CHANGED"],
    ["INSUFFICIENT_AVAILABLE"],
    ["UNKNOWN_ITEM"],
    ["RECIPE_RETIRED"],
    ["ORDER_STATE_CHANGED"],
  ])("defines the %s conflict code", (code) => {
    expect(CONFLICT_CODES).toContain(code);
  });

  it("requires a conflict to carry server state, local intent and resolutions", () => {
    const conflict = {
      commandId: COMMAND,
      code: "REVISION_CHANGED" as const,
      serverSnapshot: { revision: "44", quantity: { value: "10", unit: "GRAM" as const } },
      localIntent: { revision: "42", quantity: { value: "12", unit: "GRAM" as const } },
      allowedResolutions: ["KEEP_SERVER", "COMPENSATE_LOCAL", "EDIT_AND_RESUBMIT"],
    };
    const parsed = SyncPushResultV1.parse({
      version: 1,
      serverRevision: "44",
      accepted: [],
      conflicts: [conflict],
    });
    expect(parsed.conflicts[0]?.allowedResolutions).toHaveLength(3);
  });

  it("rejects a conflict that discards local intent", () => {
    expect(() =>
      SyncPushResultV1.parse({
        version: 1,
        serverRevision: "44",
        accepted: [],
        conflicts: [
          {
            commandId: COMMAND,
            code: "REVISION_CHANGED",
            serverSnapshot: { revision: "44" },
            allowedResolutions: ["KEEP_SERVER"],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an empty resolution list, which would strand the command", () => {
    expect(() =>
      SyncPushResultV1.parse({
        version: 1,
        serverRevision: "44",
        accepted: [],
        conflicts: [
          {
            commandId: COMMAND,
            code: "REVISION_CHANGED",
            serverSnapshot: { revision: "44" },
            localIntent: { revision: "42" },
            allowedResolutions: [],
          },
        ],
      }),
    ).toThrow();
  });
});
