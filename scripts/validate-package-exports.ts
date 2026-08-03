import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

type ExportTarget = string | { [key: string]: ExportTarget };

type PackageJson = {
  name?: string;
  exports?: Record<string, ExportTarget>;
};

type ValidationFailure = {
  pkgDir: string;
  exportName: string;
  kind: string;
  target: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function* walkExportTargets(
  value: ExportTarget,
  path: string[] = [],
): Generator<{ path: string[]; target: string }> {
  if (typeof value === "string") {
    yield { path, target: value };
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    yield* walkExportTargets(child, [...path, key]);
  }
}

function kindFromPath(path: string[]): string {
  return path.length === 0 ? "default" : path.join(".");
}

function shouldValidateTarget(target: string): boolean {
  return target.startsWith("./dist/");
}

function validatePackage(pkgDir: string): ValidationFailure[] {
  const pkgJsonPath = join(pkgDir, "package.json");
  const pkg = readJson<PackageJson>(pkgJsonPath);
  if (!pkg.exports) {
    return [];
  }

  const failures: ValidationFailure[] = [];
  for (const [exportName, exportValue] of Object.entries(pkg.exports)) {
    for (const { path, target } of walkExportTargets(exportValue)) {
      if (!shouldValidateTarget(target)) {
        continue;
      }
      const absTarget = join(pkgDir, target);
      if (existsSync(absTarget)) {
        continue;
      }
      failures.push({
        pkgDir,
        exportName,
        kind: kindFromPath(path),
        target,
      });
    }
  }

  return failures;
}

const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")),
  )
  .map((entry) => join(packagesRoot, entry.name));

const failures = packageDirs.flatMap(validatePackage);

if (failures.length > 0) {
  console.error("Package export validation failed:");
  for (const failure of failures) {
    const relPkgDir = failure.pkgDir.replace(`${repoRoot}/`, "");
    console.error(
      `- ${relPkgDir} export ${failure.exportName} (${failure.kind}) -> missing ${failure.target}`,
    );
  }
  process.exit(1);
}

console.log(`Validated package exports for ${packageDirs.length} package(s).`);
