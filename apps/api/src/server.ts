import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import { InventoryCommandV1, SyncPushRequestV1, SyncPushResultV1 } from "@simple-flame/contracts";
import { PostgresInventoryLedgerRepository } from "@simple-flame/persistence-postgres";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Sql } from "postgres";

import { translateCommand } from "./routes/translate-command.js";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SessionStore,
  canSubmitCommands,
  safeEquals,
  type AuthenticatedSession,
} from "./plugins/auth.js";

/**
 * The command API.
 *
 * Every mutation arrives as a versioned command with its own idempotency key and
 * is applied inside one database transaction. The HTTP layer deliberately owns
 * no inventory logic: it authenticates, authorises, validates the envelope, and
 * hands off. Business rules live in the domain where they are testable without a
 * server.
 */

declare module "fastify" {
  interface FastifyRequest {
    session?: AuthenticatedSession;
  }
}

/** Keys whose values must never reach a log line or an audit row. */
const REDACTED_KEYS = new Set([
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "csrf",
  "secret",
  "apikey",
  "email",
  "phone",
  "address",
]);

/**
 * Strip secrets and customer PII before anything is persisted or logged.
 *
 * Applied recursively because the offending value is usually nested inside a
 * command payload rather than at the top level.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? "[redacted]"
      : redact(nested, depth + 1);
  }
  return output;
}

export type ServerDeps = Readonly<{
  sql: Sql;
  sessions: SessionStore;
  /** Injected so tests are deterministic. */
  now?: () => Date;
}>;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ genReqId: () => randomUUID(), logger: false });
  await app.register(cookie);

  const ledger = new PostgresInventoryLedgerRepository(deps.sql);

  async function recordAudit(
    organizationId: string,
    actorId: string | null,
    requestId: string,
    kind: string,
    detail: unknown,
  ): Promise<void> {
    await deps.sql`
      INSERT INTO audit_events (id, organization_id, actor_id, request_id, kind, detail)
      VALUES (${randomUUID()}, ${organizationId}, ${actorId}, ${requestId}, ${kind},
              ${deps.sql.json(redact(detail) as never)})
    `;
  }

  /** Resolve the session cookie, or 401. */
  async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    const session = await deps.sessions.resolve(raw);
    if (!session) {
      await reply.code(401).send({ error: "session expired or revoked" });
      return;
    }
    request.session = session;
  }

  /**
   * Double-submit CSRF check on state-changing requests.
   *
   * The cookie alone is not enough: a browser attaches it to a cross-site form
   * post automatically. The header cannot be set cross-origin without CORS
   * consent, so requiring both proves the request came from our own page.
   */
  async function verifyCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.session) return;
    const presented = request.headers[CSRF_HEADER];
    if (typeof presented !== "string" || !safeEquals(presented, request.session.csrfToken)) {
      await reply.code(403).send({ error: "invalid csrf token" });
    }
  }

  app.get("/health", async () => ({ status: "ok" }));

  /**
   * Readiness is separate from liveness on purpose: a process that is running
   * but cannot reach its database must fail readiness so it stops taking
   * traffic, while still answering /health so it is not killed and restarted
   * into the same broken state.
   */
  app.get("/ready", async (_request, reply) => {
    try {
      await deps.sql`SELECT 1`;
      return { status: "ready", database: "reachable" };
    } catch {
      return reply.code(503).send({ status: "not-ready", database: "unreachable" });
    }
  });

  app.post(
    "/v1/sync/push",
    { preHandler: [requireSession, verifyCsrf] },
    async (request, reply) => {
      const session = request.session!;
      if (!canSubmitCommands(session.role)) {
        await recordAudit(session.organizationId, session.userId, String(request.id), "command.denied", {
          role: session.role,
        });
        return reply.code(403).send({ error: "role may not submit commands" });
      }

      const parsed = SyncPushRequestV1.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: "invalid sync payload", issues: parsed.error.issues });
      }

      const accepted: { commandId: string; revision: string; duplicate: boolean }[] = [];
      for (const command of parsed.data.commands) {
        // Commands carry the organization they belong to. Trusting that over the
        // session would let a client write into someone else's data.
        if (command.organizationId !== session.organizationId) {
          return reply.code(403).send({ error: "command organization does not match session" });
        }
        let entries;
        try {
          entries = translateCommand(command);
        } catch (error) {
          // An untranslatable command must fail loudly. Accepting it and posting
          // nothing would tell the client its mutation landed when it did not.
          return reply.code(422).send({
            error: (error as Error).message,
            commandId: command.commandId,
          });
        }
        const result = await ledger.appendOnce(
          command.commandId,
          session.organizationId,
          entries,
        );
        accepted.push({
          commandId: command.commandId,
          revision: result.revision,
          duplicate: result.duplicate,
        });
      }

      await recordAudit(
        session.organizationId,
        session.userId,
        String(request.id),
        "sync.push",
        { commandIds: accepted.map((entry) => entry.commandId) },
      );

      const revisions = accepted.map((entry) => BigInt(entry.revision));
      const serverRevision =
        revisions.length > 0
          ? revisions.reduce((highest, current) => (current > highest ? current : highest)).toString()
          : parsed.data.knownRevision;

      return reply.code(200).send(
        SyncPushResultV1.parse({ version: 1, serverRevision, accepted, conflicts: [] }),
      );
    },
  );

  app.get("/v1/sync/pull", { preHandler: [requireSession] }, async (request, reply) => {
    const session = request.session!;
    const since = String((request.query as Record<string, unknown>)["sinceRevision"] ?? "0");
    if (!/^\d+$/.test(since)) {
      return reply.code(422).send({ error: "sinceRevision must be a whole number" });
    }
    const rows = await deps.sql`
      SELECT id, item_id, location_id, cause,
             on_hand_delta::text, reserved_delta::text, incoming_delta::text,
             occurred_at, revision::text
      FROM inventory_ledger_entries
      WHERE organization_id = ${session.organizationId} AND revision > ${since}::bigint
      ORDER BY revision ASC
      LIMIT 500
    `;
    return reply.code(200).send({ version: 1, entries: rows });
  });

  app.get("/v1/read/projection", { preHandler: [requireSession] }, async (request, reply) => {
    const session = request.session!;
    const query = request.query as Record<string, string | undefined>;
    if (!query["itemId"] || !query["locationId"]) {
      return reply.code(422).send({ error: "itemId and locationId are required" });
    }
    // Organization comes from the SESSION, never from the query string: taking
    // it from the caller would make cross-tenant reads a matter of typing.
    const projection = await ledger.getProjection(
      session.organizationId,
      query["itemId"],
      query["locationId"],
    );
    return reply.code(200).send(projection);
  });

  return app;
}

export { InventoryCommandV1 };
