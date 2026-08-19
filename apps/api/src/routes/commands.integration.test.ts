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
const LOCATION = "0199a1f0-0000-7000-8000-000000000005";

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

function command(organizationId: string) {
  return {
    version: 1 as const,
    commandId: randomUUID(),
    organizationId,
    actorId: randomUUID(),
    deviceId: "workshop-laptop",
    baseRevision: "0",
    occurredAtLocal: "2026-08-16T12:00:00.000Z",
    queuedAt: "2026-08-16T12:00:01.000Z",
    type: "inventory.receive" as const,
    payload: {
      itemId: ITEM,
      locationId: LOCATION,
      quantity: { value: "4535.9237", unit: "GRAM" as const },
      lot: null,
    },
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
