import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sharedPackages = [
  "domain",
  "contracts",
  "application",
  "sync",
  "persistence-contracts",
  "ui",
  "test-kit",
];

const forbiddenImports = [
  "@tauri-apps/",
  "apps/web",
  "apps/api",
  "apps/worker",
  "persistence-indexeddb",
  "persistence-postgres",
];

function moduleSpecifiers(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const specifiers = new Set();

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.add(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers];
}

function matchesForbiddenImport(specifier, token) {
  if (token.endsWith("/")) {
    return specifier.startsWith(token);
  }

  return (
    specifier === token ||
    specifier.startsWith(`${token}/`) ||
    specifier.endsWith(`/${token}`) ||
    specifier.includes(`/${token}/`)
  );
}

async function sourceFiles(directory) {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function findBoundaryViolations(root) {
  const violations = [];

  for (const packageName of sharedPackages) {
    const directory = path.join(root, "packages", packageName, "src");
    for (const file of await sourceFiles(directory)) {
      const source = await readFile(file, "utf8");
      const specifiers = moduleSpecifiers(source, file);
      for (const token of forbiddenImports) {
        if (specifiers.some((specifier) => matchesForbiddenImport(specifier, token))) {
          violations.push({ file, token });
        }
      }
    }
  }

  return violations;
}

async function run() {
  const violations = await findBoundaryViolations(process.cwd());
  if (violations.length === 0) {
    console.log("Architecture boundaries: 0 violations.");
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.file}: forbidden platform dependency ${violation.token}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  await run();
}
