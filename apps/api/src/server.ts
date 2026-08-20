import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import {
  InventoryCommandV1,
  SyncPullRequestV1,
  SyncPushRequestV1,
  SyncPushResultV1,
  type InventoryCommand,
  type SyncConflict,
} from "@simple-flame/contracts";
import {
  CommandIdCollisionError,
  InsufficientAvailableError,
  InvalidLedgerStateError,
  type AppendResult,
  type LedgerEntryDraft,
  type ProjectionRecord,
} from "@simple-flame/persistence-contracts";
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

/**
 * What an operator may do about a command the server refused.
 *
 * COMPENSATE_LOCAL is deliberately absent from both refusals below: neither
 * posted anything, so there is nothing to compensate for. Either the operator
 * accepts server state, or they rebase the command and send it again.
 */
const REFUSED_COMMAND_RESOLUTIONS = ["KEEP_SERVER", "EDIT_AND_RESUBMIT"] as const;

function insufficientConflict(
  command: InventoryCommand,
  snapshot: ProjectionRecord,
): SyncConflict {
  return {
    commandId: command.commandId,
    code: "INSUFFICIENT_AVAILABLE",
    serverSnapshot: snapshot,
    // The command itself, verbatim. A conflict that dropped what the operator
    // meant would discard their work under the guise of reporting it.
    localIntent: command,
    allowedResolutions: [...REFUSED_COMMAND_RESOLUTIONS],
    // Phrased from the snapshot rather than from the error's `requested`, which
    // is a sentinel word on the negative-on-hand branch and would read as a
    // quantity here.
    explanation: `${command.type} would leave item ${snapshot.itemId} at ${snapshot.locationId} short: on hand ${snapshot.onHand}, reserved ${snapshot.reserved}, available ${snapshot.available}.`,
  };
}

function revisionChangedConflict(
  command: InventoryCommand,
  snapshot: ProjectionRecord,
): SyncConflict {
  return {
    commandId: command.commandId,
    code: "REVISION_CHANGED",
    serverSnapshot: snapshot,
    localIntent: command,
    allowedResolutions: [...REFUSED_COMMAND_RESOLUTIONS],
    explanation: `Item ${snapshot.itemId} at ${snapshot.locationId} is at revision ${snapshot.revision}; the command was composed against ${command.baseRevision}.`,
  };
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

  /**
   * A reservation the client composed against stock that has since moved, or
   * null if its belief still holds.
   *
   * Advisory: the appendOnce availability check remains the hard guarantee.
   * This exists so a stale client is told its reservation was refused because
   * the world changed, rather than silently consuming stock it never saw.
   *
   * Two things deliberately do NOT count as the world changing. A replay is
   * not staleness — this command's own entries are part of the history it
   * would be measured against, and answering an acknowledged command with a
   * conflict would invite the operator to resubmit it under a fresh id and
   * reserve the same stock twice. Nor is work THIS PUSH has already applied:
   * a batch that receives and then reserves composed both at the same known
   * revision, and counting its own receipt against it would make every mixed
   * offline batch conflict with itself.
   *
   * `applied` is what the loop has actually accepted so far, never the ids the
   * envelope merely claims. Taking it from the envelope would let a client
   * excuse another device's writes by naming their command ids — including as
   * replays, which are accepted without posting and so would whitelist a
   * competing writer at no cost.
   */
  async function firstItemChangedSince(
    organizationId: string,
    command: Extract<InventoryCommand, { type: "order.reserve" }>,
    applied: ReadonlySet<string>,
  ): Promise<ProjectionRecord | null> {
    const base = BigInt(command.baseRevision);
    const { locationId } = command.payload;
    for (const line of command.payload.lines) {
      const history = (await ledger.listEntries(organizationId, line.finishedItemId)).filter(
        (entry) => entry.locationId === locationId,
      );
      // The command posts to every line in one transaction, so its entries
      // appearing against any line prove the whole command already applied.
      if (history.some((entry) => entry.commandId === command.commandId)) return null;
      const moved = history.some(
        (entry) => BigInt(entry.revision) > base && !applied.has(entry.commandId),
      );
      if (moved) return ledger.getProjection(organizationId, line.finishedItemId, locationId);
    }
    return null;
  }

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
      const conflicts: SyncConflict[] = [];

      for (const command of parsed.data.commands) {
        // Commands carry the organization they belong to. Trusting that over the
        // session would let a client write into someone else's data.
        if (command.organizationId !== session.organizationId) {
          return reply.code(403).send({ error: "command organization does not match session" });
        }

        // Optimistic concurrency, for reservations only. A receipt or an
        // adjustment is a signed delta whose meaning does not depend on what
        // the client observed, so both apply regardless of baseRevision.
        if (command.type === "order.reserve") {
          const stale = await firstItemChangedSince(
            session.organizationId,
            command,
            new Set(accepted.map((entry) => entry.commandId)),
          );
          if (stale) {
            conflicts.push(revisionChangedConflict(command, stale));
            break;
          }
        }

        // Release is applied from the order's own reservation history, which a
        // pure translation cannot read; every other command maps to ledger
        // entries before it reaches the repository.
        let apply: () => Promise<AppendResult>;
        if (command.type === "order.release") {
          const { orderId, locationId, reason } = command.payload;
          apply = () =>
            ledger.releaseOrder(
              command.commandId,
              session.organizationId,
              orderId,
              locationId,
              reason,
            );
        } else {
          let entries: readonly LedgerEntryDraft[];
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
          apply = () => ledger.appendOnce(command.commandId, session.organizationId, entries);
        }

        try {
          const result = await apply();
          accepted.push({
            commandId: command.commandId,
            revision: result.revision,
            duplicate: result.duplicate,
          });
        } catch (error) {
          if (error instanceof InsufficientAvailableError) {
            conflicts.push(
              insufficientConflict(
                command,
                await ledger.getProjection(
                  session.organizationId,
                  error.itemId,
                  error.locationId,
                ),
              ),
            );
            // Stop the batch at the first conflict. Commands queued after this
            // one may have been composed on the assumption that it applied, so
            // applying them anyway would build on an intent that never landed.
            // They appear in neither list and the client resubmits them.
            break;
          }
          if (error instanceof CommandIdCollisionError || error instanceof InvalidLedgerStateError) {
            // Integrity failures, not reconcilable divergence: there is no
            // server state the client could rebase this command onto, so a
            // conflict offering it resolutions would be a lie.
            //
            // `accepted` rides along because the commands before this one have
            // already committed. A bare error would leave the client unable to
            // tell what landed — the failure this task removed from the
            // availability path, reappearing on a narrower one.
            return reply
              .code(409)
              .send({ error: error.message, commandId: command.commandId, accepted });
          }
          throw error;
        }
      }

      await recordAudit(
        session.organizationId,
        session.userId,
        String(request.id),
        "sync.push",
        {
          commandIds: accepted.map((entry) => entry.commandId),
          // Recorded separately: a push that reports only what landed leaves no
          // trace of what was refused or why.
          conflicts: conflicts.map((conflict) => ({
            commandId: conflict.commandId,
            code: conflict.code,
          })),
        },
      );

      const revisions = accepted.map((entry) => BigInt(entry.revision));
      const serverRevision =
        revisions.length > 0
          ? revisions.reduce((highest, current) => (current > highest ? current : highest)).toString()
          : parsed.data.knownRevision;

      // Always 200 once the envelope parsed: a conflict is a reportable outcome
      // the client can act on, not a failure of the request.
      return reply.code(200).send(
        SyncPushResultV1.parse({ version: 1, serverRevision, accepted, conflicts }),
      );
    },
  );

  app.get("/v1/sync/pull", { preHandler: [requireSession] }, async (request, reply) => {
    const session = request.session!;
    const query = request.query as Record<string, unknown>;
    const since = String(query["sinceRevision"] ?? "0");
    if (!/^\d+$/.test(since)) {
      return reply.code(422).send({ error: "sinceRevision must be a whole number" });
    }
    // Bounds and default come from the contract rather than being restated
    // here: a route that allowed a page the schema forbids would be a second
    // definition of the protocol, free to drift from the published one.
    const requested = query["limit"];
    const parsedLimit = SyncPullRequestV1.shape.limit.safeParse(
      requested === undefined ? undefined : Number(String(requested)),
    );
    if (!parsedLimit.success) {
      return reply
        .code(422)
        .send({ error: "invalid limit", issues: parsedLimit.error.issues });
    }
    const limit = parsedLimit.data;
    // One more row than asked for, so a full page can be told apart from the
    // last page. Without that signal a client whose entries land exactly on the
    // boundary cannot know whether to come back.
    const rows = await deps.sql`
      SELECT id, item_id, location_id, cause,
             on_hand_delta::text, reserved_delta::text, incoming_delta::text,
             occurred_at, revision::text
      FROM inventory_ledger_entries
      WHERE organization_id = ${session.organizationId} AND revision > ${since}::bigint
      ORDER BY revision ASC
      LIMIT ${limit + 1}
    `;
    return reply
      .code(200)
      .send({ version: 1, entries: rows.slice(0, limit), hasMore: rows.length > limit });
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
