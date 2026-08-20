import { describe, expect, it } from "vitest";

import {
  CommandIdCollisionError,
  InsufficientAvailableError,
  InvalidLedgerStateError,
  type InventoryLedgerRepository,
  type LedgerEntryDraft,
} from "./inventory-ledger.js";

/**
 * The behavioural contract every ledger adapter must satisfy.
 *
 * Exported as a function so PostgreSQL, IndexedDB and SQLite all run the SAME
 * assertions rather than each adapter proving something slightly different.
 * Parity is the point: Phase 2's desktop store has to behave identically to the
 * cloud one or offline reconciliation cannot be reasoned about.
 */
export function runInventoryLedgerContract(
  name: string,
  createRepository: () => Promise<{
    repository: InventoryLedgerRepository;
    reset: () => Promise<void>;
    dispose: () => Promise<void>;
  }>,
): void {
  describe(`${name} satisfies the inventory ledger contract`, () => {
    const ORG = "0199a1f0-0000-7000-8000-000000000001";
    // A second tenant, so idempotency can be proven to be scoped rather than global.
    const OTHER_ORG = "0199a1f0-0000-7000-8000-000000000002";
    const ITEM = "0199a1f0-0000-7000-8000-000000000004";
    const LOCATION = "0199a1f0-0000-7000-8000-000000000005";
    const OTHER_LOCATION = "0199a1f0-0000-7000-8000-000000000006";
    const ORDER = "0199a1f0-0000-7000-8000-00000000000a";
    const OTHER_ORDER = "0199a1f0-0000-7000-8000-00000000000b";

    function receipt(quantity: string): LedgerEntryDraft {
      return {
        itemId: ITEM,
        locationId: LOCATION,
        cause: "RECEIPT",
        onHandDelta: quantity,
        reservedDelta: "0",
        incomingDelta: "0",
        occurredAt: "2026-08-15T14:30:00.000Z",
      };
    }

    function reservation(quantity: string): LedgerEntryDraft {
      return { ...receipt("0"), cause: "ORDER_RESERVATION", reservedDelta: quantity };
    }

    function release(quantity: string): LedgerEntryDraft {
      return { ...receipt("0"), cause: "RESERVATION_RELEASE", reservedDelta: `-${quantity}` };
    }

    /**
     * A receipt against an expected inbound, which clears the incoming it
     * arrives against. Called with no matching order outstanding, this is the
     * shape of a caller-supplied outstanding quantity that overshoots.
     */
    function receiptClearingIncoming(quantity: string): LedgerEntryDraft {
      return { ...receipt(quantity), incomingDelta: `-${quantity}` };
    }

    it("posts one receipt exactly once", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        const commandId = "0199a1f0-0000-7000-8000-0000000000c1";
        const first = await repository.appendOnce(commandId, ORG, [receipt("4535.9237")]);
        const second = await repository.appendOnce(commandId, ORG, [receipt("4535.9237")]);

        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        // The replay must return the ORIGINAL result, not a fresh one.
        expect(second.revision).toBe(first.revision);

        const projection = await repository.getProjection(ORG, ITEM, LOCATION);
        expect(projection.onHand).toBe("4535.9237");
      } finally {
        await dispose();
      }
    });

    it("refuses a command id replayed by a different organization", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        // commandId is client-supplied, so one tenant can name an id another
        // has used. Treating that as a replay would hand the second tenant the
        // first one's stored result and silently drop its own command.
        const commandId = "0199a1f0-0000-7000-8000-0000000000ce";
        await repository.appendOnce(commandId, ORG, [receipt("10")]);
        await expect(
          repository.appendOnce(commandId, OTHER_ORG, [receipt("7")]),
        ).rejects.toThrow(CommandIdCollisionError);

        // Neither tenant sees the other: the collision is loud and writes nothing.
        expect(await repository.listEntries(OTHER_ORG, ITEM)).toHaveLength(0);
        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(1);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).onHand).toBe("10");
      } finally {
        await dispose();
      }
    });

    it("refuses a command that would drive reserved negative", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000cf", ORG, [receipt("10")]);
        // Releasing a reservation that was never made. Reserved would land on
        // -3 while on-hand stays 10, so neither of the older checks notices.
        await expect(
          repository.appendOnce("0199a1f0-0000-7000-8000-0000000000e0", ORG, [release("3")]),
        ).rejects.toThrow(InvalidLedgerStateError);

        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(1);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("0");
      } finally {
        await dispose();
      }
    });

    it("refuses a command that would drive incoming negative", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        // Clearing inbound stock that was never ordered. On-hand rises to 5, so
        // the on-hand and reserved checks both pass and only incoming is wrong.
        await expect(
          repository.appendOnce("0199a1f0-0000-7000-8000-0000000000e1", ORG, [
            receiptClearingIncoming("5"),
          ]),
        ).rejects.toThrow(InvalidLedgerStateError);

        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(0);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).incoming).toBe("0");
      } finally {
        await dispose();
      }
    });

    it("uses a compensating entry instead of editing history", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c2", ORG, [receipt("100")]);
        const before = await repository.listEntries(ORG, ITEM);
        expect(before).toHaveLength(1);

        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c3", ORG, [
          {
            ...receipt("-100"),
            cause: "ADMINISTRATIVE_REVERSAL",
            compensatesEventId: before[0]!.eventId,
          },
        ]);

        const after = await repository.listEntries(ORG, ITEM);
        expect(after).toHaveLength(2);
        // The original entry is untouched; correction is additive.
        expect(after[0]!.eventId).toBe(before[0]!.eventId);
        expect(after[0]!.onHandDelta).toBe(before[0]!.onHandDelta);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).onHand).toBe("0");
      } finally {
        await dispose();
      }
    });

    it("refuses a reservation that exceeds available", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c4", ORG, [receipt("10")]);
        await expect(
          repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c5", ORG, [reservation("40")]),
        ).rejects.toThrow(InsufficientAvailableError);

        // The rejected command must leave nothing behind.
        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(1);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("0");
      } finally {
        await dispose();
      }
    });

    it("does not allocate the same stock to concurrent reservations", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c6", ORG, [receipt("10")]);

        // Eight racers, each wanting 8 of the 10 on hand, so at most ONE can
        // legitimately win.
        //
        // KNOWN LIMITATION, do not read more into a green result than it earns:
        // this asserts the OUTCOME (no double allocation) but does not prove the
        // adapter's serialisation mechanism is what produces it. Mutation-tested
        // against the PostgreSQL adapter with its advisory lock deleted and this
        // test still passed, because postgres.js dispatches these calls over its
        // pool such that each transaction observes the previous commit. Proving
        // the lock is load-bearing needs genuinely interleaved transactions on
        // separate connections with a barrier between read and write. Flagged
        // for the final review pass rather than left as an implied guarantee.
        const racers = Array.from({ length: 8 }, (_, index) =>
          repository.appendOnce(
            `0199a1f0-0000-7000-8000-0000000000${(0xd0 + index).toString(16)}`,
            ORG,
            [reservation("8")],
          ),
        );
        const results = await Promise.allSettled(racers);

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        // More than one winner means the same stock was promised twice.
        expect(fulfilled).toHaveLength(1);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("8");
      } finally {
        await dispose();
      }
    });

    it("rolls back every entry when one entry in the command is invalid", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000c9", ORG, [receipt("10")]);
        await expect(
          repository.appendOnce("0199a1f0-0000-7000-8000-0000000000ca", ORG, [
            receipt("5"),
            reservation("999"),
          ]),
        ).rejects.toThrow();

        // Atomicity: the valid first entry must not survive on its own.
        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(1);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).onHand).toBe("10");
      } finally {
        await dispose();
      }
    });

    it("advances the revision monotonically", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        const a = await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000cb", ORG, [
          receipt("1"),
        ]);
        const b = await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000cc", ORG, [
          receipt("1"),
        ]);
        expect(BigInt(b.revision) > BigInt(a.revision)).toBe(true);
      } finally {
        await dispose();
      }
    });

    it("releases only the reservations the named order still holds", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f0", ORG, [receipt("20")]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f1", ORG, [
          { ...reservation("4"), metadata: { orderId: ORDER } },
        ]);
        // A second order on the same item and location. Releasing by item would
        // free this too, and the projection alone cannot tell the two apart.
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f2", ORG, [
          { ...reservation("7"), metadata: { orderId: OTHER_ORDER } },
        ]);

        const result = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-0000000000f3",
          ORG,
          ORDER,
          LOCATION,
          "CANCELLED",
        );

        expect(result.duplicate).toBe(false);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]!.cause).toBe("RESERVATION_RELEASE");
        expect(result.entries[0]!.reservedDelta).toBe("-4");
        expect(result.entries[0]!.metadata).toEqual({ orderId: ORDER, reason: "CANCELLED" });
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("7");
      } finally {
        await dispose();
      }
    });

    it("releases a partly released order down to what is still outstanding", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f4", ORG, [receipt("30")]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f5", ORG, [
          { ...reservation("9"), metadata: { orderId: ORDER } },
        ]);
        // A partial hand-back already recorded against the same order, so a
        // release computed from the gross reservation would over-release by 2.
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f6", ORG, [
          { ...release("2"), metadata: { orderId: ORDER } },
        ]);

        const result = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-0000000000f7",
          ORG,
          ORDER,
          LOCATION,
          "REFUNDED",
        );

        expect(result.entries[0]!.reservedDelta).toBe("-7");
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("0");
      } finally {
        await dispose();
      }
    });

    it("posts nothing for an order with nothing outstanding", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f8", ORG, [receipt("12")]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000f9", ORG, [
          { ...reservation("5"), metadata: { orderId: ORDER } },
        ]);
        await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-0000000000fa",
          ORG,
          ORDER,
          LOCATION,
          "FULFILLED",
        );

        // A second release under a fresh command id: idempotency cannot be what
        // saves this, only the order having nothing left to give back.
        const second = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-0000000000fb",
          ORG,
          ORDER,
          LOCATION,
          "SUPERSEDED",
        );

        expect(second.duplicate).toBe(false);
        expect(second.entries).toEqual([]);
        expect(BigInt(second.revision) > 0n).toBe(true);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("0");
        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(3);

        // Posting no rows does not make it an unrecorded command: a retry of an
        // empty release must be recognised rather than evaluated afresh, or the
        // exactly-once promise holds only for commands that happened to write.
        const replayed = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-0000000000fb",
          ORG,
          ORDER,
          LOCATION,
          "SUPERSEDED",
        );
        expect(replayed.duplicate).toBe(true);
        expect(replayed.revision).toBe(second.revision);
      } finally {
        await dispose();
      }
    });

    it("does not turn an over-released order back into a reservation", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f07", ORG, [receipt("40")]);
        // One order holds 5, so the item's own reserved stays non-negative and
        // the release below is accepted on its own terms...
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f08", ORG, [
          { ...reservation("5"), metadata: { orderId: OTHER_ORDER } },
        ]);
        // ...while THIS order nets to -3, having been given back more than it
        // ever took. Negating that would post a release that reserves.
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f09", ORG, [
          { ...release("3"), metadata: { orderId: ORDER } },
        ]);

        const result = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-000000000f0a",
          ORG,
          ORDER,
          LOCATION,
          "CANCELLED",
        );

        expect(result.entries).toEqual([]);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("2");
      } finally {
        await dispose();
      }
    });

    it("replays a release under the same command id without releasing twice", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000fc", ORG, [receipt("15")]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000fd", ORG, [
          { ...reservation("6"), metadata: { orderId: ORDER } },
        ]);

        const commandId = "0199a1f0-0000-7000-8000-0000000000fe";
        const first = await repository.releaseOrder(commandId, ORG, ORDER, LOCATION, "CANCELLED");
        const second = await repository.releaseOrder(commandId, ORG, ORDER, LOCATION, "CANCELLED");

        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(second.revision).toBe(first.revision);
        expect(await repository.listEntries(ORG, ITEM)).toHaveLength(3);
      } finally {
        await dispose();
      }
    });

    it("does not release another organization's reservation", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f01", OTHER_ORG, [
          receipt("18"),
        ]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f02", OTHER_ORG, [
          { ...reservation("8"), metadata: { orderId: ORDER } },
        ]);

        // Same order id, wrong tenant. Order ids are not globally unique across
        // organizations, so the scope has to come from the caller's session.
        const result = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-000000000f03",
          ORG,
          ORDER,
          LOCATION,
          "CANCELLED",
        );

        expect(result.entries).toEqual([]);
        expect((await repository.getProjection(OTHER_ORG, ITEM, LOCATION)).reserved).toBe("8");
      } finally {
        await dispose();
      }
    });

    it("does not release a reservation held at a different location", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f04", ORG, [receipt("25")]);
        await repository.appendOnce("0199a1f0-0000-7000-8000-000000000f05", ORG, [
          { ...reservation("3"), metadata: { orderId: ORDER } },
        ]);

        const result = await repository.releaseOrder(
          "0199a1f0-0000-7000-8000-000000000f06",
          ORG,
          ORDER,
          OTHER_LOCATION,
          "CANCELLED",
        );

        expect(result.entries).toEqual([]);
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).reserved).toBe("3");
      } finally {
        await dispose();
      }
    });

    it("returns a zeroed projection for an item with no history", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        const projection = await repository.getProjection(ORG, ITEM, LOCATION);
        expect(projection).toMatchObject({ onHand: "0", reserved: "0", available: "0" });
      } finally {
        await dispose();
      }
    });

    it("preserves exact decimal values through a storage round trip", async () => {
      const { repository, reset, dispose } = await createRepository();
      try {
        await reset();
        await repository.appendOnce("0199a1f0-0000-7000-8000-0000000000cd", ORG, [
          receipt("4535.9237"),
        ]);
        // Not 4535.923700000001, and not 4535.92.
        expect((await repository.getProjection(ORG, ITEM, LOCATION)).onHand).toBe("4535.9237");
      } finally {
        await dispose();
      }
    });
  });
}
