import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findBoundaryViolations } from "./check-boundaries.mjs";

test("shared packages cannot import platform adapters", async () => {
  const violations = await findBoundaryViolations(process.cwd());
  assert.deepEqual(violations, []);
});

test("reports each forbidden import once with its source file and token", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "simple-flame-boundaries-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const sourceDirectory = path.join(root, "packages", "domain", "src");
  const sourceFile = path.join(sourceDirectory, "forbidden.ts");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    sourceFile,
    'import "@tauri-apps/api";\nimport "@simple-flame/persistence-postgres";\n',
    "utf8",
  );

  assert.deepEqual(await findBoundaryViolations(root), [
    { file: sourceFile, token: "@tauri-apps/" },
    { file: sourceFile, token: "persistence-postgres" },
  ]);
});

test("ignores forbidden-looking text that is not a module import", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "simple-flame-boundaries-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const sourceDirectory = path.join(root, "packages", "domain", "src");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    path.join(sourceDirectory, "message.ts"),
    'export const examplePackageName = "@tauri-apps/api";\n',
    "utf8",
  );

  assert.deepEqual(await findBoundaryViolations(root), []);
});
