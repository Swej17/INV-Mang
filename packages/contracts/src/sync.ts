import { z } from "zod";

import { InventoryCommandV1 } from "./inventory-commands.js";
import { Revision, Uuid } from "./common.js";

/**
 * Push/pull protocol shared by the PWA today and the Tauri shell in Phase 2.
 *
 * The invariant this encodes: no local intent is ever discarded silently. A
 * command either lands, comes back as a duplicate, or comes back as a conflict
 * that still carries what the client meant and how it may proceed.
 */

export const CONFLICT_CODES = [
  "REVISION_CHANGED",
  "INSUFFICIENT_AVAILABLE",
  "UNKNOWN_ITEM",
  "RECIPE_RETIRED",
  "ORDER_STATE_CHANGED",
] as const;

export const ConflictCode = z.enum(CONFLICT_CODES);

export const ConflictResolution = z.enum([
  /** Abandon the local command and take server state as-is. */
  "KEEP_SERVER",
  /** Post a new compensating command that reaches the intended end state. */
  "COMPENSATE_LOCAL",
  /** Rebase the command on current state and resubmit it. */
  "EDIT_AND_RESUBMIT",
]);

export const SyncConflictV1 = z.object({
  commandId: Uuid,
  code: ConflictCode,
  /** What the server holds now. */
  serverSnapshot: z.record(z.string(), z.unknown()),
  /**
   * What the client meant. Required: a conflict without local intent gives the
   * operator nothing to decide with and effectively discards their work.
   */
  localIntent: z.record(z.string(), z.unknown()),
  allowedResolutions: z
    .array(ConflictResolution)
    .min(1, "a conflict must offer at least one resolution or the command is stranded"),
  explanation: z.string().nullable().default(null),
});

export const SyncPushRequestV1 = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  knownRevision: Revision,
  /** Uploaded in the order they were queued locally. */
  commands: z.array(InventoryCommandV1).min(1, "a push must carry at least one command"),
});

export const AcceptedCommandV1 = z.object({
  commandId: Uuid,
  revision: Revision,
  /** True when this command had already been applied; the original result stands. */
  duplicate: z.boolean(),
});

export const SyncPushResultV1 = z.object({
  version: z.literal(1),
  serverRevision: Revision,
  accepted: z.array(AcceptedCommandV1),
  conflicts: z.array(SyncConflictV1),
});

export const SyncPullRequestV1 = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  sinceRevision: Revision,
  limit: z.int().positive().max(1000).default(500),
});

/**
 * Query-string form of a pull request.
 *
 * `/v1/sync/pull` is a GET, so its parameters arrive as strings rather than
 * the JSON-typed body `SyncPullRequestV1` describes. Forcing that schema onto
 * a query string verbatim would fail on every request: `version` requires the
 * JS number `1`, and `limit` requires a JS number, but a query string can only
 * ever hand either one back as `"1"`. This schema exists to coerce exactly
 * those two fields; `deviceId` and `sinceRevision` keep the identical shape
 * and meaning as the body schema. `sinceRevision` defaults to `"0"` here
 * (full history) since a GET naturally supports omission as "give me
 * everything" — the body schema leaves it required because a push always
 * carries an explicit `knownRevision` alongside it.
 */
export const SyncPullQueryV1 = z.object({
  version: z.coerce.number().pipe(z.literal(1)),
  deviceId: z.string().min(1),
  sinceRevision: Revision.default("0"),
  limit: z.coerce.number().int().positive().max(1000).default(500),
});

export type SyncConflict = z.infer<typeof SyncConflictV1>;
export type SyncPushRequest = z.infer<typeof SyncPushRequestV1>;
export type SyncPushResult = z.infer<typeof SyncPushResultV1>;
export type SyncPullQuery = z.infer<typeof SyncPullQueryV1>;
