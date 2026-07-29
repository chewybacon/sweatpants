import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Physical architecture guard.
 *
 * It rejects package/module cycles, source-relative imports that leave a package,
 * undeclared workspace dependencies, and prohibited edges in the target durable
 * runtime DAG. The target policy activates as each target package is introduced,
 * which keeps independently buildable migration stages possible without allowing
 * an extracted hub to grow an accidental legacy dependency.
 */

type DependencyMap = Record<string, string>;
type PackageJson = {
  name?: string;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
};

type WorkspacePackage = {
  readonly name: string;
  readonly directory: string;
  readonly manifest: PackageJson;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");
const appsRoot = join(repoRoot, "apps");
const baselinePath = join(repoRoot, "scripts", "module-graph-baseline.json");

/** Consumer -> allowed workspace dependencies for the final target graph. */
const targetEdges: Readonly<Record<string, readonly string[]>> = {
  "@sweatpants/foundation": [],
  "@sweatpants/durable-effects": ["@sweatpants/foundation"],
  "@sweatpants/durable-execution": ["@sweatpants/durable-effects", "@sweatpants/foundation"],
  "@sweatpants/journal-authority": [
    "@sweatpants/durable-execution",
    "@sweatpants/durable-effects",
    "@sweatpants/foundation",
  ],
  "@sweatpants/history-store": ["@sweatpants/foundation"],
  "@sweatpants/agent-sdk": [
    "@sweatpants/durable-effects",
    "@sweatpants/durable-execution",
    "@sweatpants/foundation",
  ],
  "@sweatpants/tool-session": [
    // Transitional DR-041/REQ-041 edge: core is the authored-tool contract
    // owner until the same stage renames it to agent-sdk. No framework edge is
    // permitted.
    "@sweatpants/agent-sdk",
    "@sweatpants/agent-sdk",
    "@sweatpants/durable-effects",
    "@sweatpants/durable-execution",
    "@sweatpants/foundation",
  ],
  "@sweatpants/chat-core": [
    // Transitional DR-048 edge: core is the authored-tool contract owner
    // until the same stage renames it to agent-sdk. No framework edge is
    // permitted.
    "@sweatpants/agent-sdk",
    "@sweatpants/agent-sdk",
    "@sweatpants/durable-effects",
    "@sweatpants/durable-execution",
    "@sweatpants/history-store",
    "@sweatpants/foundation",
  ],
  "@sweatpants/durable-chat-runtime": [
    "@sweatpants/agent-sdk",
    "@sweatpants/chat-core",
    "@sweatpants/durable-effects",
    "@sweatpants/foundation",
    "@sweatpants/session-contract",
    "@sweatpants/tool-session",
    "@sweatpants/journal-authority",
    "@sweatpants/durable-execution",
    "@sweatpants/durable-streams",
    "@sweatpants/history-store",
  ],
  "@sweatpants/agent-host": [
    "@sweatpants/agent-sdk",
    "@sweatpants/chat-core",
    "@sweatpants/durable-chat-runtime",
    "@sweatpants/durable-effects",
    "@sweatpants/durable-execution",
    "@sweatpants/durable-streams",
    "@sweatpants/foundation",
    "@sweatpants/session-contract",
    "@sweatpants/a2a",
    "@sweatpants/journal-authority",
    "@sweatpants/history-store",
    "@sweatpants/stream-bridge",
  ],
  "@sweatpants/execution-store-memory": [
    "@sweatpants/journal-authority",
    "@sweatpants/durable-execution",
    "@sweatpants/foundation",
  ],
  "@sweatpants/execution-store-redis": [
    "@sweatpants/journal-authority",
    "@sweatpants/durable-execution",
    "@sweatpants/foundation",
  ],
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function workspacePackages(workspaceRoots: readonly string[]): readonly WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const workspaceRoot of workspaceRoots) {
    for (const entry of readdirSync(workspaceRoot)) {
      const directory = join(workspaceRoot, entry);
      const manifestPath = join(directory, "package.json");
      try {
        statSync(manifestPath);
      } catch {
        continue;
      }
      const manifest = readJson<PackageJson>(manifestPath);
      if (manifest.name) {
        packages.push({ name: manifest.name, directory, manifest });
      }
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function declaredDependencies(manifest: PackageJson): ReadonlySet<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/** Finds every cycle in a directed graph, reported from its entry node. */
function findCycles(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((node) => [node, WHITE]));
  const cycles: string[][] = [];
  const stack: string[] = [];

  function visit(node: string): void {
    color.set(node, GREY);
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      if (color.get(next) === GREY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (color.get(next) === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node) === WHITE) {
      visit(node);
    }
  }
  return cycles;
}

function packageGraph(packages: readonly WorkspacePackage[]): {
  nodes: string[];
  edges: Map<string, Set<string>>;
} {
  const names = new Set(packages.map((pkg) => pkg.name));
  return {
    nodes: [...names].sort(),
    edges: new Map(
      packages.map((pkg) => [
        pkg.name,
        new Set(
          [...declaredDependencies(pkg.manifest)].filter((dependency) => names.has(dependency)),
        ),
      ]),
    ),
  };
}

function* sourceFiles(directory: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield path;
    }
  }
}

function importSpecifiers(source: string): readonly string[] {
  const values = new Set<string>();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(|\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    values.add(match[1]!);
  }
  return [...values];
}

function statementImportSpecifiers(source: string): ReadonlySet<string> {
  const values = new Set<string>();
  const pattern =
    /^\s*(?:import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*)["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    values.add(match[1]!);
  }
  return values;
}

function relativeModuleGraphSpecifiers(source: string): readonly string[] {
  const values = new Set<string>();
  for (const match of source.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
    values.add(match[1]!);
  }
  return [...values];
}

function resolveSourceTarget(
  file: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  const resolved = resolve(dirname(file), specifier);
  for (const candidate of [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    join(resolved, "index.ts"),
  ]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function fileGraph(packageSrc: string): { nodes: string[]; edges: Map<string, Set<string>> } {
  const nodes = [...sourceFiles(packageSrc)];
  const known = new Set(nodes);
  const edges = new Map<string, Set<string>>();
  for (const file of nodes) {
    const targets = new Set<string>();
    for (const specifier of relativeModuleGraphSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSourceTarget(file, specifier, known);
      if (target && target !== file) {
        targets.add(target);
      }
    }
    edges.set(file, targets);
  }
  return { nodes, edges };
}

function isTestSource(file: string): boolean {
  return (
    file.includes(
      `${process.platform === "win32" ? "\\" : "/"}__tests__${process.platform === "win32" ? "\\" : "/"}`,
    ) || /\.(?:test|spec)\.tsx?$/.test(file)
  );
}

function workspaceImport(specifier: string, names: ReadonlySet<string>): string | undefined {
  return [...names].find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function isOutside(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory === ".." ||
    pathFromDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

function importFailures(
  packages: readonly WorkspacePackage[],
  options: { readonly allowSourceRelativeCrossingsFrom?: ReadonlySet<string> } = {},
): readonly string[] {
  const failures: string[] = [];
  const names = new Set(packages.map((pkg) => pkg.name));

  for (const pkg of packages) {
    const src = join(pkg.directory, "src");
    const dependencies = declaredDependencies(pkg.manifest);
    for (const file of sourceFiles(src)) {
      const source = readFileSync(file, "utf8");
      const statementImports = statementImportSpecifiers(source);
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          const unresolved = resolve(dirname(file), specifier);
          if (
            isOutside(unresolved, src) &&
            !options.allowSourceRelativeCrossingsFrom?.has(pkg.directory)
          ) {
            failures.push(
              `source-relative import crosses package root: ${relative(repoRoot, file)} -> ${specifier}`,
            );
          }
          continue;
        }
        const imported = workspaceImport(specifier, names);
        if (imported === pkg.name && statementImports.has(specifier) && !isTestSource(file)) {
          failures.push(
            `production package-self import hides module edges: ${relative(repoRoot, file)} -> ${specifier}`,
          );
        } else if (imported && imported !== pkg.name && !dependencies.has(imported)) {
          failures.push(
            `undeclared workspace import: ${relative(repoRoot, file)} -> ${specifier} (declare ${imported})`,
          );
        }
      }
    }

    const allowed = targetEdges[pkg.name];
    if (allowed) {
      for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
        if (names.has(dependency) && !allowed.includes(dependency)) {
          failures.push(`forbidden target DAG edge: ${pkg.name} -> ${dependency}`);
        }
      }
    }
  }
  return failures.sort();
}

function main(): void {
  const found: string[] = [];
  const packages = workspacePackages([packagesRoot]);
  const apps = workspacePackages([appsRoot]);
  const packageGraphResult = packageGraph(packages);
  for (const cycle of findCycles(packageGraphResult.nodes, packageGraphResult.edges)) {
    found.push(`package cycle: ${cycle.join(" -> ")}`);
  }

  for (const pkg of packages) {
    const src = join(pkg.directory, "src");
    try {
      statSync(src);
    } catch {
      continue;
    }
    const graph = fileGraph(src);
    for (const cycle of findCycles(graph.nodes, graph.edges)) {
      found.push(
        `module cycle in ${relative(packagesRoot, pkg.directory)}: ${cycle
          .map((file) => relative(src, file))
          .join(" -> ")}`,
      );
    }
  }

  // Existing app source-relative debt is handled by the closure memo, but app
  // workspace dependencies are checked now so clean builds cannot pass while
  // production/tests rely on undeclared pnpm-hoisted packages.
  const policyFailures = importFailures([...packages, ...apps], {
    allowSourceRelativeCrossingsFrom: new Set(apps.map((app) => app.directory)),
  });
  if (policyFailures.length > 0) {
    console.error(
      `Module graph validation failed: ${policyFailures.length} architecture violation(s).\n`,
    );
    for (const failure of policyFailures) {
      console.error(`  ${failure}`);
    }
    process.exit(1);
  }

  const baseline: string[] = (() => {
    try {
      return readJson<string[]>(baselinePath);
    } catch {
      return [];
    }
  })();

  if (process.argv.includes("--update-baseline")) {
    writeFileSync(baselinePath, `${JSON.stringify(found.sort(), null, 2)}\n`);
    console.log(`Wrote baseline with ${found.length} accepted cycle(s).`);
    return;
  }

  const accepted = new Set(baseline);
  const introduced = found.filter((cycle) => !accepted.has(cycle));
  const fixed = baseline.filter((cycle) => !found.includes(cycle));

  if (introduced.length > 0) {
    console.error(`Module graph validation failed: ${introduced.length} new cycle(s).\n`);
    for (const cycle of introduced) {
      console.error(`  ${cycle}`);
    }
    console.error(
      "\nCycles must be broken, not suppressed. The usual fix is to move the shared\n" +
        "declarations into a leaf module that both sides import. The baseline is a\n" +
        "ratchet for pre-existing debt and may only shrink.",
    );
    process.exit(1);
  }

  if (fixed.length > 0) {
    console.error(`${fixed.length} baselined cycle(s) are fixed. Run with --update-baseline:\n`);
    for (const cycle of fixed) {
      console.error(`  ${cycle}`);
    }
    process.exit(1);
  }

  console.log(
    `Module graph OK: ${packages.length} packages, no package cycles, ` +
      `${found.length} baselined module cycle(s), and no architecture violations.`,
  );
}

main();
