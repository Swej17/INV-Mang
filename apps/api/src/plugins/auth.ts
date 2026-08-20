import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Sql } from "postgres";

/**
 * Opaque server-side sessions.
 *
 * The browser holds a random token in a secure HTTP-only cookie and nothing
 * else — no identity, no role, no claims. Two consequences that a
 * self-describing token could not give us: a stolen cookie is revocable
 * server-side, and the client cannot read or tamper with its own role.
 *
 * Only the SHA-256 of the token is stored, so a database leak cannot be replayed
 * as a live session.
 */

export const SESSION_COOKIE = "sf_session";
export const CSRF_HEADER = "x-sf-csrf";

export type SessionRole = "OWNER_ADMIN" | "PRODUCTION" | "FULFILLMENT";

export type AuthenticatedSession = Readonly<{
  sessionId: string;
  userId: string;
  organizationId: string;
  role: SessionRole;
  csrfToken: string;
}>;

/**
 * Verifies an identity assertion from the auth provider.
 *
 * Behind a port because Supabase Auth needs a live project and SMTP that this
 * environment does not have. The session lifecycle below — which is where the
 * security actually lives — stays fully testable with a fake, and wiring real
 * Supabase becomes configuration rather than a rewrite.
 */
export interface IdentityVerifier {
  /** Resolves the provider's subject and email, or null when the token is bad. */
  verify(tokenHash: string): Promise<{ subject: string; email: string } | null>;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Constant-time compare; a length-varying compare leaks the token by timing. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type SessionIssue = Readonly<{
  userId: string;
  organizationId: string;
  role: SessionRole;
  ttlMinutes: number;
  userAgent?: string | null;
}>;

export class SessionStore {
  constructor(private readonly sql: Sql) {}

  /** Mint a session. Returns the raw cookie value ONCE; only its hash is kept. */
  async issue(input: SessionIssue): Promise<{ cookieValue: string; csrfToken: string; sessionId: string }> {
    const cookieValue = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const sessionId = crypto.randomUUID();

    await this.sql`
      INSERT INTO sessions (id, user_id, organization_id, token_hash, csrf_token, expires_at, user_agent)
      VALUES (
        ${sessionId}, ${input.userId}, ${input.organizationId}, ${hashToken(cookieValue)},
        ${csrfToken}, now() + (${input.ttlMinutes} || ' minutes')::interval,
        ${input.userAgent ?? null}
      )
    `;
    return { cookieValue, csrfToken, sessionId };
  }

  /** Resolve a cookie to a live session, or null. Expiry and revocation both count. */
  async resolve(cookieValue: string): Promise<AuthenticatedSession | null> {
    const rows = await this.sql`
      SELECT s.id, s.user_id, s.organization_id, s.csrf_token, u.role, u.active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(cookieValue)}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
    `;
    const row = rows[0];
    if (!row) return null;
    // A deactivated user's existing sessions must stop working immediately,
    // not merely at expiry.
    if (row["active"] !== true) return null;

    return {
      sessionId: String(row["id"]),
      userId: String(row["user_id"]),
      organizationId: String(row["organization_id"]),
      role: row["role"] as SessionRole,
      csrfToken: String(row["csrf_token"]),
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.sql`UPDATE sessions SET revoked_at = now() WHERE id = ${sessionId}`;
  }

  /** Revoke every session for a user — used on role change or compromise. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.sql`
      UPDATE sessions SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  }
}

/** Role sets permitted to perform each kind of action. */
const WRITE_ROLES: readonly SessionRole[] = ["OWNER_ADMIN", "PRODUCTION", "FULFILLMENT"];
const ADMIN_ROLES: readonly SessionRole[] = ["OWNER_ADMIN"];

export function canSubmitCommands(role: SessionRole): boolean {
  return WRITE_ROLES.includes(role);
}

export function isAdministrator(role: SessionRole): boolean {
  return ADMIN_ROLES.includes(role);
}
