import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CommandIdCollisionError,
  type AppendResult,
} from "@simple-flame/persistence-contracts";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDisposableDatabase, type DisposableDatabase } from "../testing/disposable-postgres.js";
import { PostgresInventoryLedgerRepository } from "./postgres-inventory-ledger.js";

/**
 * Proves the database-level guarantees the schema CLAIMS.
 *
 * A cold review found every one of these could be deleted from the migration
 * without a single test failing: the append-only trigger, the cause CHECK, the
 * "moves something" CHECK, and the numeric column type. They all worked — but
 * their continued existence was itself only a convention, which is exactly what
 * the trigger's own comment says is not good enough.
 */

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const ORG_B = "0199a1f0-0000-7000-8000-0000000000b0";
const ITEM = "0199a1f0-0000-7000-8000-000000000004";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";
const LOCATION_B = "0199a1f0-0000-7000-8000-000000000006";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
}

let db: DisposableDatabase;

function repo(): PostgresInventoryLedgerRepository {
  return new PostgresInventoryLedgerRepository(db.sql);
}

function receipt(quantity: string, locationId = LOCATION) {
  return {
    itemId: ITEM,
    locationId,
    cause: "RECEIPT" as const,
    onHandDelta: quantity,
    reservedDelta: "0",
    incomingDelta: "0",
    occurredAt: "2026-08-16T00:00:00.000Z",
  };
}

beforeEach(async () => {
  if (!db) {
    db = await createDisposableDatabase();
    await db.sql.unsafe(migration("0001_inventory_ledger.sql"));
    await db.sql.unsafe(migration("0007_purchase_ordered_cause.sql"));
  }
  await db.sql.unsafe("TRUNCATE inventory_ledger_entries, processed_commands RESTART IDENTITY CASCADE");
  await db.sql.unsafe("ALTER SEQUENCE inventory_revision_seq RESTART WITH 1");
});

afterAll(async () => {
  await db?.drop();
});

describe("quantities are stored as exact numeric, not floating point", () => {
  it("declares numeric with scale 8, not a float type", async () => {
    // Swapping these columns to double precision left all 8 contract tests
    // green, because 4535.9237 survives a float round trip.
    const rows = await db.sql`
      SELECT column_name, data_type, numeric_scale
      FROM information_schema.columns
      WHERE table_name = 'inventory_ledger_entries'
        AND column_name IN ('on_hand_delta', 'reserved_delta', 'incoming_delta')
      ORDER BY column_name
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row["data_type"]).toBe("numeric");
      expect(Number(row["numeric_scale"])).toBe(8);
    }
  });

  it("sums ten separate 0.1 receipts to exactly 1", async () => {
    // The value float cannot represent: as double this yields
    // 0.9999999999999999. Only exact numeric gives "1".
    for (let index = 0; index < 10; index += 1) {
      await repo().appendOnce(
        `0199a1f0-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
        ORG,
        [receipt("0.1")],
      );
    }
    expect((await repo().getProjection(ORG, ITEM, LOCATION)).onHand).toBe("1");
  });
});

describe("the append-only trigger is real", () => {
  it("rejects UPDATE on a posted entry", async () => {
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000201", ORG, [receipt("100")]);
    await expect(
      db.sql.unsafe("UPDATE inventory_ledger_entries SET on_hand_delta = 1"),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects DELETE on a posted entry", async () => {
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000202", ORG, [receipt("100")]);
    await expect(db.sql.unsafe("DELETE FROM inventory_ledger_entries")).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("schema constraints are real", () => {
  it("rejects an unknown ledger cause", async () => {
    await expect(
      db.sql.unsafe(`
        INSERT INTO processed_commands (command_id, organization_id, result_json)
        VALUES ('0199a1f0-0000-7000-8000-000000000301', '${ORG}', '{}'::jsonb);
        INSERT INTO inventory_ledger_entries
          (id, organization_id, location_id, item_id, command_id, cause, on_hand_delta, occurred_at, revision)
        VALUES ('0199a1f0-0000-7000-8000-000000000401', '${ORG}', '${LOCATION}', '${ITEM}',
                '0199a1f0-0000-7000-8000-000000000301', 'SHRINKAGE_MAYBE', 1, now(), 1)
      `),
    ).rejects.toThrow(/cause_known/);
  });

  it("rejects an entry that moves nothing", async () => {
    await expect(
      db.sql.unsafe(`
        INSERT INTO processed_commands (command_id, organization_id, result_json)
        VALUES ('0199a1f0-0000-7000-8000-000000000302', '${ORG}', '{}'::jsonb);
        INSERT INTO inventory_ledger_entries
          (id, organization_id, location_id, item_id, command_id, cause, occurred_at, revision)
        VALUES ('0199a1f0-0000-7000-8000-000000000402', '${ORG}', '${LOCATION}', '${ITEM}',
                '0199a1f0-0000-7000-8000-000000000302', 'RECEIPT', now(), 1)
      `),
    ).rejects.toThrow(/moves_something/);
  });

  it("requires a ledger entry to reference a recorded command", async () => {
    await expect(
      db.sql.unsafe(`
        INSERT INTO inventory_ledger_entries
          (id, organization_id, location_id, item_id, command_id, cause, on_hand_delta, occurred_at, revision)
        VALUES ('0199a1f0-0000-7000-8000-000000000403', '${ORG}', '${LOCATION}', '${ITEM}',
                '0199a1f0-0000-7000-8000-0000000009ff', 'RECEIPT', 1, now(), 1)
      `),
    ).rejects.toThrow(/foreign key|command_id/i);
  });
});

describe("write-path invariants", () => {
  it("refuses a consumption larger than on-hand", async () => {
    // "Available inventory cannot be negative" had no test on the write path.
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000501", ORG, [receipt("10")]);
    await expect(
      repo().appendOnce("0199a1f0-0000-7000-8000-000000000502", ORG, [receipt("-40")]),
    ).rejects.toThrow();
    expect((await repo().getProjection(ORG, ITEM, LOCATION)).onHand).toBe("10");
  });

  it("keeps locations separate for one item", async () => {
    // Location scoping worked but nothing asserted it.
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000601", ORG, [
      receipt("100", LOCATION),
      receipt("7", LOCATION_B),
    ]);
    expect((await repo().getProjection(ORG, ITEM, LOCATION)).onHand).toBe("100");
    expect((await repo().getProjection(ORG, ITEM, LOCATION_B)).onHand).toBe("7");
  });
});

describe("the advisory lock is load-bearing", () => {
  /**
   * Two ingredients make this meaningful, and removing either restores the old
   * blind spot: SEPARATE postgres clients, so postgres.js cannot serialise the
   * calls over one pooled connection, and a BEFORE INSERT stall that widens the
   * read-to-write window so both transactions read before either writes.
   *
   * Without pg_advisory_xact_lock this test fails with reserved = "16" against
   * on-hand 10 — the double allocation. Do not "simplify" the stall away.
   */
  const STALL = `
    CREATE OR REPLACE FUNCTION test_stall_before_insert() RETURNS trigger AS $fn$
    BEGIN PERFORM pg_sleep(0.75); RETURN NEW; END; $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER test_stall BEFORE INSERT ON inventory_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION test_stall_before_insert();`;

  it("serialises interleaved reservations on separate connections", async () => {
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000701", ORG, [receipt("10")]);
    await db.sql.unsafe(STALL);

    const a = postgres(db.connectionUri, { max: 1, onnotice: () => {} });
    const b = postgres(db.connectionUri, { max: 1, onnotice: () => {} });
    try {
      // Force both connections live before racing, so connection setup does not
      // accidentally serialise them.
      await a`SELECT 1`;
      await b`SELECT 1`;

      const reservation = {
        itemId: ITEM,
        locationId: LOCATION,
        cause: "ORDER_RESERVATION" as const,
        onHandDelta: "0",
        reservedDelta: "8",
        incomingDelta: "0",
        occurredAt: "2026-08-16T00:00:00.000Z",
      };

      const results = await Promise.allSettled([
        new PostgresInventoryLedgerRepository(a).appendOnce(
          "0199a1f0-0000-7000-8000-000000000702",
          ORG,
          [reservation],
        ),
        new PostgresInventoryLedgerRepository(b).appendOnce(
          "0199a1f0-0000-7000-8000-000000000703",
          ORG,
          [reservation],
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await repo().getProjection(ORG, ITEM, LOCATION)).reserved).toBe("8");
    } finally {
      await a.end({ timeout: 5 });
      await b.end({ timeout: 5 });
      await db.sql.unsafe("DROP TRIGGER IF EXISTS test_stall ON inventory_ledger_entries");
    }
  }, 60_000);
});

describe("a command id whose insert loses the primary-key race", () => {
  /**
   * Reaches the 23505 branch deterministically instead of hoping for a race.
   *
   * The replay lookup runs BEFORE the advisory lock, so holding that lock on a
   * separate connection parks appendOnce in exactly the window where its lookup
   * has already come back empty. Committing the competing processed_commands
   * row underneath it then guarantees the insert conflicts. Waiting on pg_locks
   * for the ungranted request, rather than sleeping, is what makes that ordering
   * a fact — remove it and the test can commit the row too early and take the
   * replay path instead, proving nothing.
   */
  const SCOPE = `${ORG}:${ITEM}:${LOCATION}`;

  async function waitUntilParkedOnTheLock(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await db.sql`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      if ((row!["waiting"] as number) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("appendOnce never blocked on the advisory lock");
  }

  /** Run one append that is guaranteed to lose the race for `commandId`. */
  async function appendLosingTheRaceTo(
    commandId: string,
    winningOrganizationId: string,
  ): Promise<AppendResult> {
    const blocker = postgres(db.connectionUri, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const blocking = blocker.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${SCOPE}, 0))`;
      acquired();
      await held;
    });

    try {
      await lockHeld;
      const parked = repo().appendOnce(commandId, ORG, [receipt("10")]);
      await waitUntilParkedOnTheLock();

      // The winner commits while the caller is parked, so the caller's own
      // insert cannot have seen it and must raise unique_violation.
      await db.sql`
        INSERT INTO processed_commands (command_id, organization_id, result_json)
        VALUES (${commandId}, ${winningOrganizationId}, ${db.sql.json({
          revision: "99",
          duplicate: false,
          entries: [],
        } as never)})
      `;
      release();
      await blocking;
      return await parked;
    } finally {
      release();
      await blocking.catch(() => {});
      await blocker.end({ timeout: 5 });
    }
  }

  it("replays the winner's result when the same organization won", async () => {
    // A retry that overtakes its own in-flight original. Exactly-once means it
    // gets the ORIGINAL result back, not a constraint error.
    const result = await appendLosingTheRaceTo("0199a1f0-0000-7000-8000-000000000901", ORG);

    expect(result.duplicate).toBe(true);
    // The stored revision, not a freshly minted one: this is the winner's
    // result verbatim rather than a recomputed answer.
    expect(result.revision).toBe("99");
    expect(result.entries).toHaveLength(0);
    // The losing attempt posted nothing.
    expect(await repo().listEntries(ORG, ITEM)).toHaveLength(0);
  }, 30_000);

  it("still fails loudly when another organization won", async () => {
    await expect(
      appendLosingTheRaceTo("0199a1f0-0000-7000-8000-000000000902", ORG_B),
    ).rejects.toThrow(CommandIdCollisionError);

    // No leak of the other organization's result, and nothing written here.
    expect(await repo().listEntries(ORG, ITEM)).toHaveLength(0);
  }, 30_000);
});

describe("organization isolation", () => {
  it("shows each organization only its own stock", async () => {
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000801", ORG, [receipt("100")]);
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000802", ORG_B, [receipt("500")]);
    expect((await repo().getProjection(ORG, ITEM, LOCATION)).onHand).toBe("100");
    expect((await repo().getProjection(ORG_B, ITEM, LOCATION)).onHand).toBe("500");
  });

  it("does not let one organization consume another's stock", async () => {
    // Previously: org A held 100, org B held 900, and org A was permitted to
    // consume 500 — landing at -400 — because both negative-stock guards read
    // the COMBINED history. "Available inventory cannot be negative" was
    // defeated by the mere presence of a second organization.
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000811", ORG, [receipt("100")]);
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000812", ORG_B, [receipt("900")]);

    await expect(
      repo().appendOnce("0199a1f0-0000-7000-8000-000000000813", ORG, [receipt("-500")]),
    ).rejects.toThrow();

    expect((await repo().getProjection(ORG, ITEM, LOCATION)).onHand).toBe("100");
    expect((await repo().getProjection(ORG_B, ITEM, LOCATION)).onHand).toBe("900");
  });

  it("keeps each organization's history separate", async () => {
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000821", ORG, [receipt("100")]);
    await repo().appendOnce("0199a1f0-0000-7000-8000-000000000822", ORG_B, [receipt("900")]);
    expect(await repo().listEntries(ORG, ITEM)).toHaveLength(1);
    expect(await repo().listEntries(ORG_B, ITEM)).toHaveLength(1);
  });
});

describe("0007 purchase-ordered cause migration", () => {
  /**
   * Applied to a database that ALREADY has 0001's table, because that is the
   * only case where it can fail. 0001 declares the CHECK inline inside
   * CREATE TABLE IF NOT EXISTS, so re-running 0001 on a live database silently
   * does nothing — a fresh-database test would pass while every existing
   * deployment kept rejecting the new cause.
   */
  let upgraded: DisposableDatabase;

  beforeEach(async () => {
    if (!upgraded) {
      upgraded = await createDisposableDatabase();
      await upgraded.sql.unsafe(migration("0001_inventory_ledger.sql"));
    }
  });

  afterAll(async () => {
    await upgraded?.drop();
  });

  async function insertCause(cause: string): Promise<void> {
    const commandId = randomUUID();
    await upgraded.sql`
      INSERT INTO processed_commands (command_id, organization_id, result_json)
      VALUES (${commandId}, ${ORG}, '{}'::jsonb)
    `;
    await upgraded.sql`
      INSERT INTO inventory_ledger_entries
        (id, organization_id, location_id, item_id, command_id, cause,
         incoming_delta, occurred_at, revision)
      VALUES (${randomUUID()}, ${ORG}, ${LOCATION}, ${ITEM}, ${commandId}, ${cause},
              1, now(), nextval('inventory_revision_seq'))
    `;
  }

  it("rejects the new cause before the migration runs", async () => {
    await expect(insertCause("PURCHASE_ORDERED")).rejects.toThrow(/cause_known/);
  });

  it("accepts the new cause after the migration runs", async () => {
    await upgraded.sql.unsafe(migration("0007_purchase_ordered_cause.sql"));
    await expect(insertCause("PURCHASE_ORDERED")).resolves.toBeUndefined();
  });

  it("still refuses an unknown cause", async () => {
    // The migration DROPs the constraint before re-adding it. Dropping and
    // forgetting to re-add would make both tests above pass while the ledger
    // silently accepted any string at all.
    await upgraded.sql.unsafe(migration("0007_purchase_ordered_cause.sql"));
    await expect(insertCause("NOT_A_REAL_CAUSE")).rejects.toThrow(/cause_known/);
  });

  it("is safe to run twice", async () => {
    // Migrations get re-applied by accident; the second run must be a no-op
    // rather than an error that halts a deployment.
    //
    // KNOWN LIMITATION: mutation-tested by removing `IF EXISTS`, and this still
    // passed. The constraint always exists when 0007 runs — 0001 creates it and
    // 0007 re-adds it — so the guard never fires on any reachable path. It is
    // kept as protection for a database where an operator dropped the
    // constraint by hand to backfill, which no test here can stage. What this
    // test does prove is that a second run leaves the constraint intact and
    // still enforcing, which is the property a deployment depends on.
    await upgraded.sql.unsafe(migration("0007_purchase_ordered_cause.sql"));
    await upgraded.sql.unsafe(migration("0007_purchase_ordered_cause.sql"));
    await expect(insertCause("PURCHASE_ORDERED")).resolves.toBeUndefined();
    await expect(insertCause("NOT_A_REAL_CAUSE")).rejects.toThrow(/cause_known/);
  });
});
