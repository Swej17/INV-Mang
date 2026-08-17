import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";

/**
 * Disposable PostgreSQL database for integration tests.
 *
 * Each run gets its own freshly created database on a real PostgreSQL 17
 * server, and drops it afterwards. That satisfies what the plan requires —
 * migrations exercised against real PostgreSQL on throwaway databases — without
 * depending on container port forwarding.
 *
 * Why not a container: Podman on this host cannot forward container ports to
 * Windows. The WSL2 kernel provides no nf_tables, so netavark cannot install
 * forwarding rules, and disabling the firewall driver removes forwarding
 * altogether. Containers start and PostgreSQL accepts connections inside them,
 * but the host can never reach the mapped port. This is a deliberate,
 * documented substitution, not a silent one — and notably NOT a fall back to
 * Docker, which remains unauthorised.
 */

const HOST = process.env["PGHOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PGPORT"] ?? 5432);
const USER = process.env["PGUSER"] ?? "postgres";
const PASSWORD = process.env["PGPASSWORD"] ?? "postgres";
const ADMIN_DB = process.env["PGDATABASE"] ?? "postgres";

export type DisposableDatabase = {
  connectionUri: string;
  sql: Sql;
  drop: () => Promise<void>;
};

function uri(database: string): string {
  return `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${database}`;
}

export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  // Underscore-prefixed suffix keeps the identifier valid without quoting.
  const name = `sf_test_${randomUUID().replaceAll("-", "")}`;

  const admin = postgres(uri(ADMIN_DB), { max: 1, onnotice: () => {} });
  try {
    // Identifier cannot be parameterised; the name is a generated hex UUID, so
    // there is no external input to inject through here.
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(uri(name), { max: 5, onnotice: () => {} });

  return {
    connectionUri: uri(name),
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(uri(ADMIN_DB), { max: 1, onnotice: () => {} });
      try {
        // WITH (FORCE) terminates leftover backends; without it a lingering
        // connection makes DROP hang and leaks a database per failed run.
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
