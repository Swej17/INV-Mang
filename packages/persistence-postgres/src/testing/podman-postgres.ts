import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Disposable PostgreSQL for integration tests, driven straight through the
 * Podman CLI.
 *
 * Deliberately not @testcontainers/postgresql: that talks the Docker HTTP API
 * through docker-modem, which hung against the Podman socket on this host —
 * containers were created but never started. Shelling out to `podman` removes
 * the compatibility layer, and it also means nothing Docker-named sits in the
 * test path, which is what the Podman-only constraint asks for.
 */

const PODMAN =
  process.env["PODMAN_BIN"] ??
  `${process.env["LOCALAPPDATA"] ?? ""}\\Programs\\Podman\\podman.exe`;

const IMAGE = process.env["POSTGRES_IMAGE"] ?? "postgres:17-alpine";

export type DisposablePostgres = {
  connectionUri: string;
  stop: () => Promise<void>;
};

async function podman(args: readonly string[]): Promise<string> {
  const { stdout } = await run(PODMAN, [...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Free-ish high port. Collisions surface immediately as a bind error. */
function choosePort(): number {
  return 55_000 + Math.floor(Math.random() * 9_000);
}

/** Retry `attempt` until it succeeds or the deadline passes. */
async function waitFor(
  deadline: number,
  containerName: string,
  attempt: () => Promise<void>,
): Promise<void> {
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        const logs = await podman(["logs", containerName]).catch(() => "(no logs)");
        await podman(["rm", "-f", containerName]).catch(() => undefined);
        throw new Error(
          `PostgreSQL container never became reachable: ${(error as Error).message}\n${logs}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Resolves only when the mapped port accepts a TCP connection from the host. */
async function probeHostPort(port: number): Promise<void> {
  const { Socket } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => fail(new Error("host port probe timed out")));
    socket.once("error", fail);
    socket.connect(port, "127.0.0.1");
  });
}

export async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const name = `sf-test-pg-${randomUUID().slice(0, 8)}`;
  const port = choosePort();
  const password = "simple-flame-test";

  await podman([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    `${port}:5432`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=simple_flame_test",
    IMAGE,
  ]);

  const deadline = Date.now() + 120_000;

  // Two-stage readiness, and BOTH stages are necessary.
  //
  // pg_isready inside the container proves the database accepts connections.
  // It does NOT prove the host can reach it: Podman's WSL port forwarding is
  // established a moment after the container starts, so a client that connects
  // the instant pg_isready passes gets ECONNREFUSED. The host-side probe is the
  // readiness signal that actually matters to a test.
  await waitFor(deadline, name, async () => {
    await podman(["exec", name, "pg_isready", "-U", "postgres", "-d", "simple_flame_test"]);
  });
  await waitFor(deadline, name, async () => {
    await probeHostPort(port);
  });

  return {
    connectionUri: `postgres://postgres:${password}@127.0.0.1:${port}/simple_flame_test`,
    stop: async () => {
      await podman(["rm", "-f", name]).catch(() => undefined);
    },
  };
}
