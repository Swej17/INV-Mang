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

export type SyncConflict = z.infer<typeof SyncConflictV1>;
export type SyncPushRequest = z.infer<typeof SyncPushRequestV1>;
export type SyncPushResult = z.infer<typeof SyncPushResultV1>;
