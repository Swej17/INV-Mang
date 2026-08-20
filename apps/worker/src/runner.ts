import type { Sql } from "postgres";

/**
 * PostgreSQL-backed job runner.
 *
 * A table rather than Redis, per the design document: for a single-operator
 * system it removes a whole service to run and gives transactional consistency
 * with the ledger for free.
 *
 * Work is LEASED, never locked. A worker that crashes mid-job simply lets its
 * lease lapse and another picks the job up — with a lock, a dead worker would
 * hold the job forever.
 */

export type JobRecord = Readonly<{
  id: string;
  organizationId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}>;

export type JobHandler = (job: JobRecord) => Promise<void>;

export type RunnerOptions = Readonly<{
  workerId: string;
  leaseSeconds: number;
  /** Injected for deterministic tests. */
  now?: () => Date;
}>;

export class JobRunner {
  constructor(
    private readonly sql: Sql,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly options: RunnerOptions,
  ) {}

  /**
   * Claim one due job.
   *
   * FOR UPDATE SKIP LOCKED is what makes several workers safe: each skips rows
   * another has already locked rather than blocking behind them, so throughput
   * scales instead of serialising.
   */
  async claim(): Promise<JobRecord | null> {
    const rows = await this.sql`
      UPDATE jobs SET
        status = 'RUNNING',
        leased_until = now() + (${this.options.leaseSeconds} || ' seconds')::interval,
        leased_by = ${this.options.workerId},
        attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'PENDING' AND run_after <= now()
        ORDER BY run_after ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, organization_id, kind, payload, attempts, max_attempts
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row["id"]),
      organizationId: String(row["organization_id"]),
      kind: String(row["kind"]),
      payload: (row["payload"] ?? {}) as Record<string, unknown>,
      attempts: Number(row["attempts"]),
      maxAttempts: Number(row["max_attempts"]),
    };
  }

  /**
   * Return jobs whose lease expired back to the queue.
   *
   * This is the recovery path for a killed worker. Without it a crash would
   * strand the job in RUNNING with nobody executing it.
   */
  async reclaimExpired(): Promise<number> {
    const rows = await this.sql`
      UPDATE jobs SET status = 'PENDING', leased_until = NULL, leased_by = NULL
      WHERE status = 'RUNNING' AND leased_until < now()
      RETURNING id
    `;
    return rows.length;
  }

  /**
   * Extend the lease on a job this worker still holds.
   *
   * Called on a heartbeat interval well under leaseSeconds so a job whose
   * handler outlives one lease period is not reclaimed and re-run by another
   * worker while still in flight. Returns false once this worker no longer
   * holds the lease (already reclaimed, or the job finished), so the caller
   * can stop renewing rather than fight a worker that has moved on.
   */
  async renewLease(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE jobs SET leased_until = now() + (${this.options.leaseSeconds} || ' seconds')::interval
      WHERE id = ${jobId} AND leased_by = ${this.options.workerId} AND status = 'RUNNING'
      RETURNING id
    `;
    return rows.length > 0;
  }

  /**
   * Terminal writes are fenced on lease ownership: the lease is only a
   * guarantee if every write that assumes it re-checks it. Without the
   * leased_by/status guard, a worker whose lease already expired and was
   * reclaimed by another worker could still complete/fail/dead-letter the
   * job out from under the new holder, clobbering its retry.
   */
  async complete(jobId: string): Promise<void> {
    await this.sql`
      UPDATE jobs SET status = 'COMPLETED', completed_at = now(),
                      leased_until = NULL, leased_by = NULL
      WHERE id = ${jobId} AND leased_by = ${this.options.workerId} AND status = 'RUNNING'
    `;
  }

  /**
   * Dead-letter a job whose kind has no registered handler.
   *
   * A missing handler is a deployment fault, not a transient failure:
   * retrying cannot fix it, so this skips the backoff/retry path in fail()
   * entirely. Fenced the same as complete()/fail() above.
   */
  async deadLetterUnknownKind(jobId: string, kind: string): Promise<void> {
    await this.sql`
      UPDATE jobs SET status = 'DEAD_LETTER', last_error = ${`no handler for kind ${kind}`},
                      leased_until = NULL, leased_by = NULL
      WHERE id = ${jobId} AND leased_by = ${this.options.workerId} AND status = 'RUNNING'
    `;
  }

  /**
   * Record a failure and decide whether to retry.
   *
   * Retries back off exponentially and are bounded. Past the bound the job goes
   * to DEAD_LETTER rather than retrying forever: a permanently failing job that
   * silently retries is indistinguishable from one that is working, and it will
   * hide a real outage.
   */
  async fail(job: JobRecord, error: Error): Promise<"RETRY" | "DEAD_LETTER"> {
    const exhausted = job.attempts >= job.maxAttempts;
    if (exhausted) {
      await this.sql`
        UPDATE jobs SET status = 'DEAD_LETTER', last_error = ${error.message},
                        leased_until = NULL, leased_by = NULL
        WHERE id = ${job.id} AND leased_by = ${this.options.workerId} AND status = 'RUNNING'
      `;
      return "DEAD_LETTER";
    }
    const backoffSeconds = Math.min(2 ** job.attempts, 3600);
    await this.sql`
      UPDATE jobs SET status = 'PENDING', last_error = ${error.message},
                      run_after = now() + (${backoffSeconds} || ' seconds')::interval,
                      leased_until = NULL, leased_by = NULL
      WHERE id = ${job.id} AND leased_by = ${this.options.workerId} AND status = 'RUNNING'
    `;
    return "RETRY";
  }

  /** Claim and run a single job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;

    const handler = this.handlers[job.kind];
    if (!handler) {
      await this.deadLetterUnknownKind(job.id, job.kind);
      return true;
    }

    // Heartbeat well inside the lease window (a third of it) so a handler
    // that outlives one lease period keeps its claim instead of being
    // reclaimed and re-run by another worker while still executing. Clamped
    // in MILLISECONDS, not seconds: the previous `Math.max(1, leaseSeconds /
    // 3) * 1000` clamped the pre-multiplication value, so leaseSeconds: 1
    // produced a 1000ms heartbeat — firing exactly when the lease expires,
    // not "well inside" it.
    const heartbeatMs = Math.max(250, (this.options.leaseSeconds * 1000) / 3);
    const heartbeat = setInterval(() => {
      // Fire-and-forget: a transient renewal failure must not crash the
      // worker mid-handler. Losing the race just means the lease lapses and
      // the fenced terminal writes below become no-ops for this worker.
      this.renewLease(job.id).catch(() => {});
    }, heartbeatMs);

    try {
      await handler(job);
      await this.complete(job.id);
    } catch (error) {
      await this.fail(job, error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
