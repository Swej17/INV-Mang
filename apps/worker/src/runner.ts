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

  async complete(jobId: string): Promise<void> {
    await this.sql`
      UPDATE jobs SET status = 'COMPLETED', completed_at = now(),
                      leased_until = NULL, leased_by = NULL
      WHERE id = ${jobId}
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
        WHERE id = ${job.id}
      `;
      return "DEAD_LETTER";
    }
    const backoffSeconds = Math.min(2 ** job.attempts, 3600);
    await this.sql`
      UPDATE jobs SET status = 'PENDING', last_error = ${error.message},
                      run_after = now() + (${backoffSeconds} || ' seconds')::interval,
                      leased_until = NULL, leased_by = NULL
      WHERE id = ${job.id}
    `;
    return "RETRY";
  }

  /** Claim and run a single job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;

    const handler = this.handlers[job.kind];
    if (!handler) {
      // An unknown kind is a deployment problem, not a transient failure:
      // retrying cannot fix it, so it dead-letters immediately.
      await this.sql`
        UPDATE jobs SET status = 'DEAD_LETTER', last_error = ${`no handler for kind ${job.kind}`},
                        leased_until = NULL, leased_by = NULL
        WHERE id = ${job.id}
      `;
      return true;
    }

    try {
      await handler(job);
      await this.complete(job.id);
    } catch (error) {
      await this.fail(job, error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }
}
