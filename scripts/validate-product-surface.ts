/**
 * Product surface validator (REQ-018, REQ-019).
 *
 * Checks:
 * 1. Allowlist integrity — each facade path root resolves to a declared package export
 * 2. Product-app experimental import prohibition for apps/yo-chat (and allowlist productApps)
 * 3. Golden-path suite imports only allowlisted facade paths
 * 4. Root README primary samples do not use experimental path patterns
 *
 * Run: pnpm validate:product-surface
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  exports?: Record<string, unknown>;
};

type Allowlist = {
  version: number;
  facadePaths: string[];
  productApps: string[];
  experimentalPathPatterns: string[];
  knownExceptions: Array<{
    file: string;
    importPath: string;
    reason: string;
    removalPlanOrExpiry: string;
  }>;
  goldenPathSuites: string[];
};

type Failure = { kind: string; message: string };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = join(repoRoot, "docs/product-facade-allowlist.json");

const IMPORT_RE =
  /(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "playwright-report" ||
      entry.name === "test-results" ||
      entry.name === ".turbo"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, acc);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|md)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function extractImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) imports.push(spec);
  }
  return imports;
}

function packageNameAndSubpath(importPath: string): { pkg: string; subpath: string } | null {
  if (!importPath.startsWith("@sweatpants/")) return null;
  const parts = importPath.split("/");
  // @scope/name[/...]
  if (parts.length < 2) return null;
  const pkg = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2).join("/");
  const subpath = rest.length === 0 ? "." : `./${rest}`;
  return { pkg, subpath };
}

function resolvePackageDir(pkgName: string): string | null {
  const packagesRoot = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesRoot, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = readJson<PackageJson>(pkgJsonPath);
    if (pkg.name === pkgName) return join(packagesRoot, entry.name);
  }
  return null;
}

function exportKeys(exportsField: Record<string, unknown> | undefined): string[] {
  if (!exportsField) return ["."];
  return Object.keys(exportsField);
}

function validateAllowlistIntegrity(allowlist: Allowlist): Failure[] {
  const failures: Failure[] = [];
  for (const facadePath of allowlist.facadePaths) {
    const parsed = packageNameAndSubpath(facadePath);
    if (!parsed) {
      failures.push({
        kind: "allowlist",
        message: `Facade path is not a @sweatpants/* import: ${facadePath}`,
      });
      continue;
    }
    const pkgDir = resolvePackageDir(parsed.pkg);
    if (!pkgDir) {
      failures.push({
        kind: "allowlist",
        message: `No workspace package found for ${parsed.pkg} (from ${facadePath})`,
      });
      continue;
    }
    const pkg = readJson<PackageJson>(join(pkgDir, "package.json"));
    const keys = exportKeys(pkg.exports);
    // Exact match or prefix match for nested export maps (e.g. ./chat covers ./chat/...)
    const ok =
      keys.includes(parsed.subpath) ||
      (parsed.subpath === "." && (keys.includes(".") || keys.includes("./"))) ||
      keys.some((key) => key === parsed.subpath);
    if (!ok) {
      failures.push({
        kind: "allowlist",
        message:
          `Facade path ${facadePath} is not declared in ${parsed.pkg} exports ` +
          `(have: ${keys.join(", ")})`,
      });
    }
  }
  return failures;
}

function matchesExperimental(importPath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (importPath === pattern || importPath.startsWith(pattern) || importPath.includes(pattern)) {
      return pattern;
    }
  }
  return null;
}

function isGrandfathered(
  allowlist: Allowlist,
  fileRel: string,
  importPath: string,
): boolean {
  return allowlist.knownExceptions.some(
    (ex) =>
      (ex.file === fileRel || fileRel.endsWith(ex.file)) &&
      (ex.importPath === importPath || importPath.startsWith(ex.importPath)),
  );
}

function isAllowlistedImport(importPath: string, facadePaths: string[]): boolean {
  if (!importPath.startsWith("@sweatpants/")) return true;
  return facadePaths.some(
    (allowed) => importPath === allowed || importPath.startsWith(`${allowed}/`),
  );
}

function validateProductAppImports(allowlist: Allowlist): Failure[] {
  const failures: Failure[] = [];
  for (const appRel of allowlist.productApps) {
    const appRoot = join(repoRoot, appRel);
    // Only enforce on app source, not e2e/tests that may probe internals intentionally.
    // Product policy covers app runtime/source trees under src/, server entry, vite config.
    const roots = [
      join(appRoot, "src"),
      join(appRoot, "express-server.ts"),
      join(appRoot, "vite.config.ts"),
    ].filter((p) => existsSync(p));

    const files: string[] = [];
    for (const root of roots) {
      const st = statSync(root);
      if (st.isDirectory()) listSourceFiles(root, files);
      else files.push(root);
    }

    for (const file of files) {
      // Skip pure test/outside-in harnesses that intentionally exercise runtimes.
      const rel = relative(repoRoot, file).replaceAll("\\", "/");
      if (rel.includes("/outside-in/") || rel.includes("/__tests__/")) continue;

      const source = readFileSync(file, "utf8");
      for (const imp of extractImports(source)) {
        const hit = matchesExperimental(imp, allowlist.experimentalPathPatterns);
        if (!hit) continue;
        if (isGrandfathered(allowlist, rel, imp)) continue;
        failures.push({
          kind: "experimental-import",
          message: `${rel} imports experimental path "${imp}" (matched ${hit})`,
        });
      }
    }
  }
  return failures;
}

function validateGoldenPathSuites(allowlist: Allowlist): Failure[] {
  const failures: Failure[] = [];
  for (const suiteRel of allowlist.goldenPathSuites) {
    const suitePath = join(repoRoot, suiteRel);
    if (!existsSync(suitePath)) {
      failures.push({
        kind: "golden-path",
        message: `Golden-path suite missing: ${suiteRel}`,
      });
      continue;
    }
    const source = readFileSync(suitePath, "utf8");
    for (const imp of extractImports(source)) {
      if (!imp.startsWith("@sweatpants/")) continue;
      if (!isAllowlistedImport(imp, allowlist.facadePaths)) {
        failures.push({
          kind: "golden-path",
          message: `${suiteRel} imports non-facade path "${imp}"`,
        });
      }
    }
  }
  return failures;
}

function validateReadmeSamples(allowlist: Allowlist): Failure[] {
  const failures: Failure[] = [];
  const readmePath = join(repoRoot, "README.md");
  if (!existsSync(readmePath)) {
    failures.push({ kind: "readme", message: "Root README.md missing" });
    return failures;
  }
  const source = readFileSync(readmePath, "utf8");
  // Scan fenced code blocks only (primary samples)
  const fenceRe = /```[\w]*\n([\s\S]*?)```/g;
  let blockIndex = 0;
  for (const match of source.matchAll(fenceRe)) {
    blockIndex += 1;
    const block = match[1] ?? "";
    for (const imp of extractImports(block)) {
      const hit = matchesExperimental(imp, allowlist.experimentalPathPatterns);
      if (hit) {
        failures.push({
          kind: "readme",
          message: `README code block #${blockIndex} uses experimental path "${imp}" (matched ${hit})`,
        });
      }
    }
    // Also ban createIsomorphicTool identifiers even without import string
    if (/\bcreateIsomorphicTool\b/.test(block) || /\bdefineIsomorphicTool\b/.test(block)) {
      failures.push({
        kind: "readme",
        message: `README code block #${blockIndex} uses experimental isomorphic tool builder`,
      });
    }
  }
  return failures;
}

function main(): void {
  if (!existsSync(allowlistPath)) {
    console.error(`Missing allowlist: ${allowlistPath}`);
    process.exit(1);
  }

  const allowlist = readJson<Allowlist>(allowlistPath);
  const failures: Failure[] = [
    ...validateAllowlistIntegrity(allowlist),
    ...validateProductAppImports(allowlist),
    ...validateGoldenPathSuites(allowlist),
    ...validateReadmeSamples(allowlist),
  ];

  if (failures.length > 0) {
    console.error("Product surface validation failed:");
    for (const failure of failures) {
      console.error(`- [${failure.kind}] ${failure.message}`);
    }
    process.exit(1);
  }

  console.log("Product surface validation passed.");
  console.log(`- facade paths: ${allowlist.facadePaths.length}`);
  console.log(`- product apps: ${allowlist.productApps.join(", ")}`);
  console.log(`- golden path suites: ${allowlist.goldenPathSuites.length}`);
}

main();
