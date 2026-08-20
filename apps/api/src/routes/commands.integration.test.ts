import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDisposableDatabase, type DisposableDatabase } from "@simple-flame/persistence-postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CSRF_HEADER, SESSION_COOKIE, SessionStore, hashToken } from "../plugins/auth.js";
import { buildServer, redact } from "../server.js";

/**
 * The command API against REAL PostgreSQL.
 *
 * Session resolution, CSRF, role checks and idempotency all depend on database
 * state, so an in-memory double would prove none of them.
 */

const ORG = "0199a1f0-0000-7000-8000-000000000001";
const ORG_B = "0199a1f0-0000-7000-8000-0000000000b0";
const ITEM = "0199a1f0-0000-7000-8000-000000000004";
const ITEM_B = "0199a1f0-0000-7000-8000-000000000006";
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";
const ORDER_A = "0199a1f0-0000-7000-8000-00000000000a";
const ORDER_B = "0199a1f0-0000-7000-8000-00000000000b";

function migrationSql(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/persistence-postgres/drizzle/${name}`, import.meta.url)),
    "utf8",
  );
}

let db: DisposableDatabase;
let app: FastifyInstance;
let sessions: SessionStore;

async function seedUser(role: string, organizationId = ORG): Promise<string> {
  const userId = randomUUID();
  await db.sql`
    INSERT INTO organizations (id, name) VALUES (${organizationId}, 'Simple Flame')
    ON CONFLICT (id) DO NOTHING
  `;
  await db.sql`
    INSERT INTO users (id, organization_id, email, role)
    VALUES (${userId}, ${organizationId}, ${`${userId}@example.test`}, ${role})
  `;
  return userId;
}

async function login(role = "OWNER_ADMIN", organizationId = ORG) {
  const userId = await seedUser(role, organizationId);
  const issued = await sessions.issue({ userId, organizationId, role: role as never, ttlMinutes: 60 });
  return { userId, organizationId, ...issued };
}

function envelope(organizationId: string, baseRevision = "0") {
  return {
    version: 1 as const,
    commandId: randomUUID(),
    organizationId,
    actorId: randomUUID(),
    deviceId: "workshop-laptop",
    baseRevision,
    occurredAtLocal: "2026-08-16T12:00:00.000Z",
    queuedAt: "2026-08-16T12:00:01.000Z",
  };
}

function command(organizationId: string) {
  return {
    ...envelope(organizationId),
    type: "inventory.receive" as const,
    payload: {
      itemId: ITEM,
      locationId: LOCATION,
      quantity: { value: "4535.9237", unit: "GRAM" as const },
      lot: null,
    },
  };
}

/**
 * Receipts for the reservation tests are counted in EACH, so an on-hand figure
 * and a reservation's `units` are the same kind of number. Grams against units
 * would still project arithmetically and hide a mistaken quantity.
 */
function receiveOf(organizationId: string, itemId: string, units: string) {
  return {
    ...envelope(organizationId),
    type: "inventory.receive" as const,
    payload: {
      itemId,
      locationId: LOCATION,
      quantity: { value: units, unit: "EACH" as const },
      lot: null,
    },
  };
}

function reserveOf(
  organizationId: string,
  orderId: string,
  baseRevision: string,
  lines: readonly { finishedItemId: string; units: number }[],
) {
  return {
    ...envelope(organizationId, baseRevision),
    type: "order.reserve" as const,
    payload: { orderId, locationId: LOCATION, lines },
  };
}

function releaseOf(organizationId: string, orderId: string, reason: string) {
  return {
    ...envelope(organizationId),
    type: "order.release" as const,
    payload: { orderId, locationId: LOCATION, reason },
  };
}

beforeEach(async () => {
  if (!db) {
    db = await createDisposableDatabase();
    await db.sql.unsafe(migrationSql("0001_inventory_ledger.sql"));
    await db.sql.unsafe(migrationSql("0006_auth_audit_jobs.sql"));
    sessions = new SessionStore(db.sql);
    app = await buildServer({ sql: db.sql, sessions });
    await app.ready();
  }
  await db.sql.unsafe(
    "TRUNCATE inventory_ledger_entries, processed_commands, audit_events, sessions, users, organizations RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("authentication", () => {
  it("rejects a request with no session cookie", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/sync/push", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown cookie value", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: "not-a-real-token" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a revoked session immediately", async () => {
    const session = await login();
    await sessions.revoke(session.sessionId);
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: session.csrfToken },
      payload: { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an expired session", async () => {
    const session = await login();
    // issued_at moves too: the schema forbids expires_at <= issued_at, and that
    // constraint is correct — an already-expired-at-issue session is nonsense.
    await db.sql`
      UPDATE sessions SET issued_at = now() - interval '2 hours',
                          expires_at = now() - interval '1 hour'
      WHERE id = ${session.sessionId}
    `;
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: session.csrfToken },
      payload: { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stops a deactivated user's existing sessions working", async () => {
    // Deactivation must take effect now, not at token expiry.
    const session = await login();
    await db.sql`UPDATE users SET active = false WHERE id = ${session.userId}`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: session.csrfToken },
      payload: { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("never stores the raw session token", async () => {
    const session = await login();
    const rows = await db.sql`SELECT token_hash FROM sessions WHERE id = ${session.sessionId}`;
    // A database leak must not yield replayable cookies.
    expect(rows[0]!["token_hash"]).not.toBe(session.cookieValue);
    expect(rows[0]!["token_hash"]).toBe(hashToken(session.cookieValue));
  });
});

describe("CSRF", () => {
  it("rejects a state-changing request with no CSRF header", async () => {
    const session = await login();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      payload: { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] },
    });
    // The cookie alone is attached automatically on a cross-site post; the
    // header is what proves the request came from our own page.
    expect(response.statusCode).toBe(403);
  });

  it("rejects a stale CSRF token from another session", async () => {
    const session = await login();
    const other = await login();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: other.csrfToken },
      payload: { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] },
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not require CSRF on a read", async () => {
    const session = await login();
    const response = await app.inject({
      method: "GET",
      url: "/v1/sync/pull?sinceRevision=0",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("command push", () => {
  async function push(session: Awaited<ReturnType<typeof login>>, body: unknown) {
    return app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: session.csrfToken },
      payload: body as never,
    });
  }

  it("returns the original result for a duplicate command id", async () => {
    const session = await login();
    const body = { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] };
    const first = await push(session, body);
    const second = await push(session, body);
    expect(first.statusCode).toBe(200);
    // Same EFFECT, flagged as a replay. The plan sketches a deep-equal check,
    // but that cannot hold while also reporting duplicate:true — and the client
    // needs to know its retry was recognised rather than applied twice.
    expect(second.json().accepted[0].revision).toBe(first.json().accepted[0].revision);
    expect(second.json().serverRevision).toBe(first.json().serverRevision);
    expect(first.json().accepted[0].duplicate).toBe(false);
    expect(second.json().accepted[0].duplicate).toBe(true);
  });

  it("actually applies the command to the ledger", async () => {
    // The gap this closes: an earlier handler recorded the command but passed
    // NO entries, so 14 tests passed while nothing was ever posted. Asserting
    // the response shape alone cannot detect that.
    const session = await login();
    await push(session, { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] });
    const rows = await db.sql`
      SELECT cause, on_hand_delta::text FROM inventory_ledger_entries WHERE item_id = ${ITEM}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["cause"]).toBe("RECEIPT");
    expect(rows[0]!["on_hand_delta"]).toBe("4535.92370000");
  });

  it("does not post a second entry for a replayed command", async () => {
    const session = await login();
    const body = { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] };
    await push(session, body);
    await push(session, body);
    const rows = await db.sql`SELECT id FROM inventory_ledger_entries WHERE item_id = ${ITEM}`;
    expect(rows).toHaveLength(1);
  });

  it("rejects a command type the API cannot apply, rather than silently accepting it", async () => {
    const session = await login();
    const base = command(ORG);
    const response = await push(session, {
      version: 1,
      deviceId: "d",
      knownRevision: "0",
      commands: [
        {
          ...base,
          type: "production.complete",
          payload: {
            batchId: randomUUID(),
            recipeVersionId: randomUUID(),
            locationId: LOCATION,
            finishedItemId: randomUUID(),
            finishedUnits: 5,
            lotOverrides: [],
          },
        },
      ],
    });
    expect(response.statusCode).toBe(422);
    const rows = await db.sql`SELECT id FROM inventory_ledger_entries`;
    expect(rows).toHaveLength(0);
  });

  it("refuses a command belonging to another organization", async () => {
    // Trusting the command's organization over the session would let a client
    // write into someone else's data.
    const session = await login("OWNER_ADMIN", ORG);
    const response = await push(session, {
      version: 1,
      deviceId: "d",
      knownRevision: "0",
      commands: [command(ORG_B)],
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a malformed payload with 422", async () => {
    const session = await login();
    const response = await push(session, { version: 1, commands: [] });
    expect(response.statusCode).toBe(422);
  });

  it("records an audit event for the push", async () => {
    const session = await login();
    await push(session, { version: 1, deviceId: "d", knownRevision: "0", commands: [command(ORG)] });
    const rows = await db.sql`SELECT kind, request_id FROM audit_events WHERE kind = 'sync.push'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["request_id"]).toBeTruthy();
  });

  async function pushCommands(
    session: Awaited<ReturnType<typeof login>>,
    knownRevision: string,
    commands: readonly unknown[],
  ) {
    return push(session, { version: 1, deviceId: "workshop-laptop", knownRevision, commands });
  }

  async function readProjection(session: Awaited<ReturnType<typeof login>>, itemId: string) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/read/projection?itemId=${itemId}&locationId=${LOCATION}`,
      cookies: { [SESSION_COOKIE]: session.cookieValue },
    });
    return response.json();
  }

  describe("conflicts", () => {
    it("returns insufficient availability as a typed conflict, not a 500", async () => {
      const session = await login();
      const seeded = await pushCommands(session, "0", [receiveOf(ORG, ITEM, "5")]);
      const knownRevision = seeded.json().serverRevision;

      const receiveThree = receiveOf(ORG, ITEM, "3");
      const reserveHundred = reserveOf(ORG, ORDER_A, knownRevision, [
        { finishedItemId: ITEM, units: 100 },
      ]);
      const receiveOne = receiveOf(ORG, ITEM, "1");

      const response = await pushCommands(session, knownRevision, [
        receiveThree,
        reserveHundred,
        receiveOne,
      ]);

      // A mid-batch conflict is a reportable outcome, not a server fault: the
      // earlier command has already committed and the client needs to be told
      // exactly which one of the three it must decide about.
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accepted.map((entry: { commandId: string }) => entry.commandId)).toEqual([
        receiveThree.commandId,
      ]);
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].code).toBe("INSUFFICIENT_AVAILABLE");
      expect(body.conflicts[0].commandId).toBe(reserveHundred.commandId);
      expect(body.conflicts[0].localIntent.commandId).toBe(reserveHundred.commandId);
      expect(body.conflicts[0].localIntent.payload.lines[0].units).toBe(100);
      expect(body.conflicts[0].serverSnapshot).toMatchObject({
        itemId: ITEM,
        onHand: "8",
        reserved: "0",
        available: "8",
      });
      expect(body.conflicts[0].allowedResolutions).toEqual(["KEEP_SERVER", "EDIT_AND_RESUBMIT"]);

      // The command queued AFTER the conflict must not have applied: it may
      // have been composed on the assumption that the reservation landed.
      const projection = await readProjection(session, ITEM);
      expect(projection.onHand).toBe("8");
      expect(projection.reserved).toBe("0");
    });

    it("refuses a stale reserve with REVISION_CHANGED", async () => {
      const session = await login();
      const seeded = await pushCommands(session, "0", [receiveOf(ORG, ITEM, "20")]);
      const currentRevision = seeded.json().serverRevision;

      // Affordable on purpose — 6 of 20 fits. A refusal therefore proves the
      // revision gate fired, not availability wearing the wrong conflict code.
      const stale = reserveOf(ORG, ORDER_A, "0", [{ finishedItemId: ITEM, units: 6 }]);
      const staleBody = (await pushCommands(session, "0", [stale])).json();
      expect(staleBody.conflicts).toHaveLength(1);
      expect(staleBody.conflicts[0].code).toBe("REVISION_CHANGED");
      expect(staleBody.conflicts[0].commandId).toBe(stale.commandId);
      expect(staleBody.accepted).toEqual([]);
      expect((await readProjection(session, ITEM)).reserved).toBe("0");

      const fresh = reserveOf(ORG, ORDER_B, currentRevision, [
        { finishedItemId: ITEM, units: 6 },
      ]);
      const freshBody = (await pushCommands(session, currentRevision, [fresh])).json();
      expect(freshBody.conflicts).toEqual([]);
      expect((await readProjection(session, ITEM)).reserved).toBe("6");
    });

    it("applies a signed delta whose baseRevision is stale, and says so", async () => {
      // The design decision H3 records: a receipt means "three more arrived",
      // which is true whatever else moved, so it must NOT be gated. Only a
      // reservation depends on the availability the client observed.
      const session = await login();
      await pushCommands(session, "0", [receiveOf(ORG, ITEM, "7")]);

      const behind = receiveOf(ORG, ITEM, "2");
      const body = (await pushCommands(session, "0", [behind])).json();

      expect(body.conflicts).toEqual([]);
      expect(body.accepted).toHaveLength(1);
      expect((await readProjection(session, ITEM)).onHand).toBe("9");
    });

    it("reports an over-large adjustment as a conflict, not only reservations", async () => {
      const session = await login();
      const knownRevision = (
        await pushCommands(session, "0", [receiveOf(ORG, ITEM, "6")])
      ).json().serverRevision;

      // A recount that would drive on-hand to -3: reconcilable divergence, the
      // operator counted against state that has moved, not a server fault.
      const adjust = {
        ...envelope(ORG, knownRevision),
        type: "inventory.adjust" as const,
        payload: {
          itemId: ITEM,
          locationId: LOCATION,
          delta: { value: "-9", unit: "EACH" as const },
          reasonCode: "PHYSICAL_COUNT" as const,
          note: null,
        },
      };
      const body = (await pushCommands(session, knownRevision, [adjust])).json();

      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].code).toBe("INSUFFICIENT_AVAILABLE");
      expect(body.conflicts[0].serverSnapshot.onHand).toBe("6");
      expect(body.conflicts[0].explanation).toContain("inventory.adjust");
      expect((await readProjection(session, ITEM)).onHand).toBe("6");
    });

    it("answers a command id another organization already used with 409", async () => {
      const owner = await login("OWNER_ADMIN", ORG);
      const stranger = await login("OWNER_ADMIN", ORG_B);
      const claimed = receiveOf(ORG, ITEM, "5");
      await pushCommands(owner, "0", [claimed]);

      const response = await pushCommands(stranger, "0", [
        { ...claimed, organizationId: ORG_B },
      ]);

      // An integrity failure, not reconcilable divergence: there is no server
      // state the stranger could rebase onto, and replaying the owner's stored
      // result would hand over its entries.
      expect(response.statusCode).toBe(409);
      expect(response.json().commandId).toBe(claimed.commandId);
      const rows = await db.sql`
        SELECT organization_id FROM inventory_ledger_entries WHERE item_id = ${ITEM}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!["organization_id"]).toBe(ORG);
    });

    it("does not treat a batch's own earlier command as a competing writer", async () => {
      // A device that queues a receipt and a reservation together composed both
      // at the same known revision. Counting its own receipt as somebody else's
      // change would make every mixed offline batch conflict with itself.
      const session = await login();
      const body = (
        await pushCommands(session, "0", [
          receiveOf(ORG, ITEM, "12"),
          reserveOf(ORG, ORDER_A, "0", [{ finishedItemId: ITEM, units: 9 }]),
        ])
      ).json();

      expect(body.conflicts).toEqual([]);
      expect(body.accepted).toHaveLength(2);
      expect((await readProjection(session, ITEM)).reserved).toBe("9");
    });

    it("reports a replayed reserve as a duplicate rather than a conflict", async () => {
      const session = await login();
      const seeded = await pushCommands(session, "0", [receiveOf(ORG, ITEM, "15")]);
      const knownRevision = seeded.json().serverRevision;
      const reserve = reserveOf(ORG, ORDER_A, knownRevision, [
        { finishedItemId: ITEM, units: 5 },
      ]);

      const first = await pushCommands(session, knownRevision, [reserve]);
      // Another device moves the same item before the retry lands, so the item
      // genuinely IS past the retry's baseRevision. Idempotency still outranks
      // staleness: the command already applied, and answering it with a
      // conflict would invite the operator to resubmit it under a fresh id and
      // reserve the stock twice.
      await pushCommands(session, knownRevision, [receiveOf(ORG, ITEM, "2")]);
      const second = await pushCommands(session, knownRevision, [reserve]);

      expect(first.json().accepted[0].duplicate).toBe(false);
      expect(second.json().conflicts).toEqual([]);
      expect(second.json().accepted[0].duplicate).toBe(true);
      expect(second.json().accepted[0].revision).toBe(first.json().accepted[0].revision);
      expect((await readProjection(session, ITEM)).reserved).toBe("5");
    });
  });

  describe("order release", () => {
    /** Reserve two items under order A and one under order B, then release A. */
    async function seedReservations(session: Awaited<ReturnType<typeof login>>) {
      const seeded = await pushCommands(session, "0", [
        receiveOf(ORG, ITEM, "20"),
        receiveOf(ORG, ITEM_B, "30"),
      ]);
      const afterReceipts = seeded.json().serverRevision;

      const reservedA = await pushCommands(session, afterReceipts, [
        reserveOf(ORG, ORDER_A, afterReceipts, [
          { finishedItemId: ITEM, units: 4 },
          { finishedItemId: ITEM_B, units: 6 },
        ]),
      ]);
      const afterA = reservedA.json().serverRevision;

      await pushCommands(session, afterA, [
        reserveOf(ORG, ORDER_B, afterA, [{ finishedItemId: ITEM, units: 7 }]),
      ]);
      return afterA;
    }

    it("releases exactly the outstanding reservation for the named order", async () => {
      const session = await login();
      await seedReservations(session);
      expect((await readProjection(session, ITEM)).reserved).toBe("11");

      const body = (await pushCommands(session, "0", [
        releaseOf(ORG, ORDER_A, "CANCELLED"),
      ])).json();
      expect(body.conflicts).toEqual([]);
      expect(body.accepted[0].duplicate).toBe(false);

      // Order B's 7 is untouched: a release names an order, not an item.
      expect((await readProjection(session, ITEM)).reserved).toBe("7");
      expect((await readProjection(session, ITEM_B)).reserved).toBe("0");

      const rows = await db.sql`
        SELECT item_id, reserved_delta::text, metadata
        FROM inventory_ledger_entries
        WHERE cause = 'RESERVATION_RELEASE'
        ORDER BY item_id ASC
      `;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => [row["item_id"], row["reserved_delta"]])).toEqual([
        [ITEM, "-4.00000000"],
        [ITEM_B, "-6.00000000"],
      ]);
      expect(rows[0]!["metadata"]).toEqual({ orderId: ORDER_A, reason: "CANCELLED" });
    });

    it("treats a second release of the same order as a no-op, not a double release", async () => {
      const session = await login();
      await seedReservations(session);
      await pushCommands(session, "0", [releaseOf(ORG, ORDER_A, "CANCELLED")]);

      // A DIFFERENT command id, so idempotency cannot be what saves this: the
      // order simply has nothing outstanding left to release.
      const body = (await pushCommands(session, "0", [
        releaseOf(ORG, ORDER_A, "SUPERSEDED"),
      ])).json();
      expect(body.conflicts).toEqual([]);
      expect(body.accepted[0].duplicate).toBe(false);

      expect((await readProjection(session, ITEM)).reserved).toBe("7");
      expect((await readProjection(session, ITEM_B)).reserved).toBe("0");
      const rows = await db.sql`
        SELECT id FROM inventory_ledger_entries WHERE cause = 'RESERVATION_RELEASE'
      `;
      expect(rows).toHaveLength(2);
    });

    it("replays a release under the same command id without posting again", async () => {
      const session = await login();
      await seedReservations(session);
      const release = releaseOf(ORG, ORDER_A, "REFUNDED");

      const first = (await pushCommands(session, "0", [release])).json();
      const second = (await pushCommands(session, "0", [release])).json();

      expect(first.accepted[0].duplicate).toBe(false);
      expect(second.accepted[0].duplicate).toBe(true);
      expect(second.accepted[0].revision).toBe(first.accepted[0].revision);
      expect((await readProjection(session, ITEM)).reserved).toBe("7");
      const rows = await db.sql`
        SELECT id FROM inventory_ledger_entries WHERE cause = 'RESERVATION_RELEASE'
      `;
      expect(rows).toHaveLength(2);
    });

    it("records a release for an order that never reserved anything", async () => {
      const session = await login();
      const body = (await pushCommands(session, "0", [
        releaseOf(ORG, ORDER_B, "FULFILLED"),
      ])).json();

      // An empty release is a legitimate no-op — the client cannot know the
      // order held nothing — so it is accepted and recorded, not refused.
      expect(body.accepted).toHaveLength(1);
      expect(body.conflicts).toEqual([]);
      const rows = await db.sql`SELECT id FROM inventory_ledger_entries`;
      expect(rows).toHaveLength(0);
    });
  });
});

describe("sync pull", () => {
  async function seedEntries(session: Awaited<ReturnType<typeof login>>, count: number) {
    await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      cookies: { [SESSION_COOKIE]: session.cookieValue },
      headers: { [CSRF_HEADER]: session.csrfToken },
      payload: {
        version: 1,
        deviceId: "workshop-laptop",
        knownRevision: "0",
        commands: Array.from({ length: count }, () => command(ORG)),
      } as never,
    });
  }

  async function pull(session: Awaited<ReturnType<typeof login>>, query: string) {
    return app.inject({
      method: "GET",
      url: `/v1/sync/pull?${query}`,
      cookies: { [SESSION_COOKIE]: session.cookieValue },
    });
  }

  it("flips hasMore at the page boundary", async () => {
    const session = await login();
    await seedEntries(session, 4);

    const short = await pull(session, "sinceRevision=0&limit=3");
    expect(short.json().entries).toHaveLength(3);
    // Four entries and a page of three: the client must be told to come back.
    expect(short.json().hasMore).toBe(true);

    const exact = await pull(session, "sinceRevision=0&limit=4");
    expect(exact.json().entries).toHaveLength(4);
    // A full page that happens to be the last one must not read as "more".
    expect(exact.json().hasMore).toBe(false);
  });

  it("continues from the last revision of the previous page", async () => {
    const session = await login();
    await seedEntries(session, 4);

    const first = await pull(session, "sinceRevision=0&limit=3");
    const cursor = first.json().entries[2].revision;
    const second = await pull(session, `sinceRevision=${cursor}&limit=3`);

    expect(second.json().entries).toHaveLength(1);
    expect(second.json().hasMore).toBe(false);
    // No overlap and no gap across the seam.
    const revisions = [...first.json().entries, ...second.json().entries].map(
      (entry: { revision: string }) => entry.revision,
    );
    expect(new Set(revisions).size).toBe(4);
  });

  it("rejects a limit outside the contract's range", async () => {
    const session = await login();
    expect((await pull(session, "sinceRevision=0&limit=0")).statusCode).toBe(422);
    expect((await pull(session, "sinceRevision=0&limit=1001")).statusCode).toBe(422);
    expect((await pull(session, "sinceRevision=0&limit=ten")).statusCode).toBe(422);
    expect((await pull(session, "sinceRevision=0&limit=1000")).statusCode).toBe(200);
  });
});

describe("health and readiness", () => {
  it("reports health without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("reports readiness separately from health", async () => {
    // Liveness and readiness answer different questions: a process that cannot
    // reach its database should stop taking traffic without being restarted.
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.json()).toMatchObject({ status: "ready", database: "reachable" });
  });
});

describe("log redaction", () => {
  it("removes secrets and customer identifiers at any depth", () => {
    const redacted = redact({
      safe: "keep",
      token: "secret-value",
      nested: { email: "owner@example.test", quantity: "10" },
      list: [{ password: "hunter2" }],
    }) as Record<string, unknown>;

    expect(redacted["safe"]).toBe("keep");
    expect(redacted["token"]).toBe("[redacted]");
    expect((redacted["nested"] as Record<string, unknown>)["email"]).toBe("[redacted]");
    expect((redacted["nested"] as Record<string, unknown>)["quantity"]).toBe("10");
    expect(((redacted["list"] as unknown[])[0] as Record<string, unknown>)["password"]).toBe(
      "[redacted]",
    );
  });
});
