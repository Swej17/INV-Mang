import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverMigrations, MIGRATIONS_DIRECTORY } from "./discover.js";

let dir: string;
function fixture(...names: string[]): string {
  dir = mkdtempSync(path.join(tmpdir(), "sf-migrations-"));
  for (const name of names) writeFileSync(path.join(dir, name), "SELECT 1;");
  return dir;
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test("orders by version and tolerates the deliberate 0005 gap", () => {
  // Deliberately written out of order on disk so a directory listing that
  // happened to be sorted could not produce this result by accident.
  const found = discoverMigrations(fixture("0006_auth.sql", "0001_ledger.sql", "0008_trace.sql"));
  expect(found.map((m) => m.version)).toEqual(["0001", "0006", "0008"]);
});

test("rejects version numbers that are not exactly 4 digits (too short)", () => {
  expect(() => discoverMigrations(fixture("001_short.sql"))).toThrow(/001_short\.sql/);
});

test("rejects version numbers that are not exactly 4 digits (too long)", () => {
  expect(() => discoverMigrations(fixture("00010_long.sql"))).toThrow(/00010_long\.sql/);
});

test("refuses two files claiming the same version", () => {
  expect(() => discoverMigrations(fixture("0007_a.sql", "0007_b.sql"))).toThrow(/duplicate/i);
});

test("refuses a malformed filename rather than skipping it", () => {
  // Skipping silently is how a migration gets left out of production.
  expect(() => discoverMigrations(fixture("0001_ledger.sql", "notes.sql"))).toThrow(/notes\.sql/);
});

test("ignores non-sql files", () => {
  const found = discoverMigrations(fixture("0001_ledger.sql", "README.md"));
  expect(found.map((m) => m.name)).toEqual(["0001_ledger.sql"]);
});

test("the shipped migrations directory resolves and is ordered", () => {
  const found = discoverMigrations(MIGRATIONS_DIRECTORY);
  expect(found.map((m) => m.version)).toEqual(["0001","0002","0003","0004","0006","0007","0008"]);
});
