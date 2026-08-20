import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DiscoveredMigration = Readonly<{
  version: string;   // zero-padded as on disk, e.g. "0007"
  name: string;      // full filename, e.g. "0007_purchase_ordered_cause.sql"
  path: string;      // absolute path
}>;

/**
 * Absolute path to the migrations directory.
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * Discovers and orders migration files from a directory.
 *
 * Migrations are identified by filenames matching NNNN_name.sql where NNNN is
 * a zero-padded version number. Files are returned sorted by numeric version,
 * so version gaps are legal (0005 is reserved; see spec).
 *
 * Duplicate versions are fatal: two files claiming the same version means
 * ambiguous order, so we refuse rather than pick one.
 *
 * Malformed .sql filenames are fatal rather than skipped. Silently skipping a
 * migration is how one gets left out of production: a file that doesn't match
 * the expected pattern is more likely a mistake than a non-migration artifact.
 */
export function discoverMigrations(directory: string): readonly DiscoveredMigration[] {
  const entries = readdirSync(directory, { encoding: "utf8" });
  const discovered = new Map<string, DiscoveredMigration>();

  for (const name of entries) {
    // Ignore non-SQL files.
    if (!name.endsWith(".sql")) continue;

    // Parse and validate: must match NNNN_name.sql where NNNN is exactly 4 digits.
    // The \d{4} requirement caps the scheme at 9999 migrations and ensures that
    // numeric and lexicographic sort produce identical results. Keep the numeric sort:
    // it is correct and remains correct if the width rule ever changes.
    const match = name.match(/^(\d{4})_(.+)\.sql$/);
    if (!match) {
      throw new Error(
        `Malformed migration filename: ${name}. Must match pattern NNNN_name.sql`,
      );
    }

    const version = match[1]!;
    const fullPath = path.resolve(directory, name);

    // Check for duplicates.
    if (discovered.has(version)) {
      throw new Error(`Duplicate migration version: ${version}`);
    }

    discovered.set(version, { version, name, path: fullPath });
  }

  // Sort by numeric version.
  const sorted = Array.from(discovered.values()).sort((a, b) =>
    Number(a.version) - Number(b.version),
  );

  return sorted;
}
