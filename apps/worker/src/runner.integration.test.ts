import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDisposableDatabase, type DisposableDatabase } from "@simple-flame/persistence-postgres/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { JobRunner, type JobRecord } from "./runner.js";

/**
 * The job runner against REAL PostgreSQL.
 *
 * FOR UPDATE SKIP LOCKED, lease expiry and backoff are all database behaviours.
 * A fake queue would prove none of them, and those are exactly the mechanics
 * that decide whether a crashed worker strands work.
 */

const ORG = "0199a1f0-0000-7000-8000-000000000001";

function migrationSql(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../packages/persistence-postgres/drizzle/${name}`, import.meta.url)),
    "utf8",
  );
}

let db: DisposableDatabase;

async function enqueue(
  kind: string,
  overrides: { runAfterSeconds?: number; maxAttempts?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await db.sql`
    INSERT INTO jobs (id, organization_id, kind, payload, run_after, max_attempts)
    VALUES (${id}, ${ORG}, ${kind}, '{}'::jsonb,
            now() + (${overrides.runAfterSeconds ?? 0} || ' seconds')::interval,
            ${overrides.maxAttempts ?? 5})
  `;
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await db.sql`SELECT status FROM jobs WHERE id = ${id}`;
  return String(rows[0]!["status"]);
}

beforeEach(async () => {
  if (!db) {
    db = await createDisposableDatabase();
    await db.sql.unsafe(migrationSql("0001_inventory_ledger.sql"));
    await db.sql.unsafe(migrationSql("0006_auth_audit_jobs.sql"));
  }
  await db.sql.unsafe("TRUNCATE jobs");
});

afterAll(async () => {
  await db?.drop();
});

function runner(
  handlers: Record<string, (job: JobRecord) => Promise<void>>,
  workerId = "w1",
  leaseSeconds = 30,
): JobRunner {
  return new JobRunner(db.sql, handlers, { workerId, leaseSeconds });
}

// Microsecond-precision epoch, not a JS Date: two sequential now()-derived
// writes can land in the same millisecond, and Date truncates below that.
async function leasedUntilEpochOf(id: string): Promise<number> {
  const rows = await db.sql`SELECT extract(epoch from leased_until) AS epoch FROM jobs WHERE id = ${id}`;
  return Number(rows[0]!["epoch"]);
}

describe("JobRunner", () => {
  it("claims and completes a due job", async () => {
    const id = await enqueue("test.ok");
    const ran: string[] = [];
    const worked = await runner({ "test.ok": async (job) => void ran.push(job.id) }).runOnce();
    expect(worked).toBe(true);
    expect(ran).toEqual([id]);
    expect(await statusOf(id)).toBe("COMPLETED");
  });

  it("returns false when nothing is due", async () => {
    expect(await runner({}).runOnce()).toBe(false);
  });

  it("does not claim a job scheduled for the future", async () => {
    await enqueue("test.ok", { runAfterSeconds: 3600 });
    expect(await runner({ "test.ok": async () => {} }).claim()).toBeNull();
  });

  it("does not hand the same job to two workers", async () => {
    // KNOWN LIMITATION: this asserts the OUTCOME, not that SKIP LOCKED is what
    // produces it. Mutation-tested with SKIP LOCKED removed and this still
    // passed — plain FOR UPDATE blocks the second worker until the first
    // commits, after which the row is no longer PENDING, so exactly one still
    // claims. The difference is throughput, not correctness: under load, plain
    // FOR UPDATE serialises every worker behind one row. Proving that needs a
    // contention benchmark rather than a correctness assertion.
    await enqueue("test.ok");
    const [a, b] = await Promise.all([
      runner({}, "w1").claim(),
      runner({}, "w2").claim(),
    ]);
    const claimed = [a, b].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
  });

  it("retries a failing job with backoff rather than dropping it", async () => {
    const id = await enqueue("test.fail");
    await runner({ "test.fail": async () => { throw new Error("boom"); } }).runOnce();
    expect(await statusOf(id)).toBe("PENDING");
    const rows = await db.sql`SELECT attempts, last_error, run_after > now() AS deferred FROM jobs WHERE id = ${id}`;
    expect(Number(rows[0]!["attempts"])).toBe(1);
    expect(String(rows[0]!["last_error"])).toContain("boom");
    // Deferred, not immediately re-runnable: an instant retry would spin.
    expect(rows[0]!["deferred"]).toBe(true);
  });

  it("dead-letters a job once attempts are exhausted", async () => {
    const id = await enqueue("test.fail", { maxAttempts: 1 });
    await runner({ "test.fail": async () => { throw new Error("boom"); } }).runOnce();
    // Retrying forever hides a real outage behind an apparently busy queue.
    expect(await statusOf(id)).toBe("DEAD_LETTER");
  });

  it("dead-letters an unknown job kind immediately", async () => {
    const id = await enqueue("test.unregistered");
    await runner({}).runOnce();
    // A missing handler is a deployment fault; retrying cannot fix it.
    expect(await statusOf(id)).toBe("DEAD_LETTER");
  });

  it("reclaims a job whose lease expired", async () => {
    const id = await enqueue("test.ok");
    await runner({}).claim();
    // Simulate a worker that died holding the lease.
    await db.sql`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = ${id}`;
    expect(await runner({}).reclaimExpired()).toBe(1);
    expect(await statusOf(id)).toBe("PENDING");
  });

  it("does not reclaim a job whose lease is still live", async () => {
    await enqueue("test.ok");
    await runner({}).claim();
    expect(await runner({}).reclaimExpired()).toBe(0);
  });

  it("renewLease extends leased_until for the worker holding the lease", async () => {
    const id = await enqueue("test.ok");
    await runner({}, "w1").claim();
    const before = await leasedUntilEpochOf(id);
    expect(await runner({}, "w1").renewLease(id)).toBe(true);
    const after = await leasedUntilEpochOf(id);
    expect(after).toBeGreaterThan(before);
  });

  it("renewLease is a no-op when another worker holds the lease", async () => {
    const id = await enqueue("test.ok");
    await runner({}, "w1").claim();
    const before = await leasedUntilEpochOf(id);
    // w2 never held this lease: renewing it must not extend w1's job.
    expect(await runner({}, "w2").renewLease(id)).toBe(false);
    expect(await leasedUntilEpochOf(id)).toBe(before);
  });

  it("renewLease is a no-op when the job is not RUNNING", async () => {
    const id = await enqueue("test.ok");
    await runner({ "test.ok": async () => {} }, "w1").runOnce();
    expect(await statusOf(id)).toBe("COMPLETED");
    expect(await runner({}, "w1").renewLease(id)).toBe(false);
  });

  it("completion is fenced: a worker that lost its lease cannot clobber the retry", async () => {
    const id = await enqueue("test.ok");
    await runner({}, "A").claim();
    // Force-expire A's lease and let B reclaim and re-claim the job.
    await db.sql`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = ${id}`;
    expect(await runner({}, "B").reclaimExpired()).toBe(1);
    await runner({}, "B").claim();
    expect(await statusOf(id)).toBe("RUNNING");
    // A does not know it lost the lease and tries to complete anyway.
    await runner({}, "A").complete(id);
    // B's claim must survive: A's write was not fenced by lease ownership.
    expect(await statusOf(id)).toBe("RUNNING");
  });

  it("failure is fenced: a worker that lost its lease cannot clobber the retry", async () => {
    const id = await enqueue("test.fail", { maxAttempts: 1 });
    const jobA = (await runner({}, "A").claim())!;
    await db.sql`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = ${id}`;
    expect(await runner({}, "B").reclaimExpired()).toBe(1);
    await runner({}, "B").claim();
    expect(await statusOf(id)).toBe("RUNNING");
    // A does not know it lost the lease and tries to record a failure anyway.
    await runner({}, "A").fail(jobA, new Error("boom"));
    expect(await statusOf(id)).toBe("RUNNING");
  });

  it("retry-scheduling failure is fenced: a worker that lost its lease cannot clobber the retry", async () => {
    // Same as above but with attempts left, so fail() takes the RETRY branch
    // (reschedule to PENDING) rather than DEAD_LETTER. That branch has its
    // own WHERE clause and is a distinct invariant from the DEAD_LETTER one.
    const id = await enqueue("test.fail", { maxAttempts: 5 });
    const jobA = (await runner({}, "A").claim())!;
    await db.sql`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = ${id}`;
    expect(await runner({}, "B").reclaimExpired()).toBe(1);
    await runner({}, "B").claim();
    expect(await statusOf(id)).toBe("RUNNING");
    // A does not know it lost the lease and tries to record a retryable failure anyway.
    expect(await runner({}, "A").fail(jobA, new Error("boom"))).toBe("RETRY");
    // B's claim must survive: the job must not flip to PENDING with a
    // rescheduled run_after out from under B.
    expect(await statusOf(id)).toBe("RUNNING");
  });

  it("a long job's lease is renewed so reclaimExpired does not steal it", async () => {
    const id = await enqueue("test.slow");
    const ran: string[] = [];
    const slowRunner = runner(
      {
        "test.slow": async (job) => {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          ran.push(job.id);
        },
      },
      "w1",
      1,
    );

    const runPromise = slowRunner.runOnce();
    // Original 1s lease would have expired by now without renewal; a fresh
    // reclaimExpired() run must not find it stealable.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await runner({}, "reclaimer").reclaimExpired()).toBe(0);

    expect(await runPromise).toBe(true);
    expect(ran).toEqual([id]);
    expect(await statusOf(id)).toBe("COMPLETED");
  });

  it("takes the oldest due job first", async () => {
    const first = await enqueue("test.ok", { runAfterSeconds: -60 });
    await enqueue("test.ok", { runAfterSeconds: -10 });
    expect((await runner({}).claim())!.id).toBe(first);
  });

  it("refuses a RUNNING job with no lease at the schema level", async () => {
    // The constraint exists so a job can never become unreclaimable.
    const id = randomUUID();
    await expect(
      db.sql`
        INSERT INTO jobs (id, organization_id, kind, status, leased_until)
        VALUES (${id}, ${ORG}, 'test.ok', 'RUNNING', NULL)
      `,
    ).rejects.toThrow(/running_has_lease/);
  });
});

describe("audit_events", () => {
  it("is append-only", async () => {
    await db.sql`
      INSERT INTO audit_events (id, organization_id, kind, detail)
      VALUES (${randomUUID()}, ${ORG}, 'test.event', '{}'::jsonb)
    `;
    await expect(db.sql.unsafe("UPDATE audit_events SET kind = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.sql.unsafe("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });
});
