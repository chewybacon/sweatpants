import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Module graph guard.
 *
 * Packages are the physical way to understand dependencies, so the graph must
 * stay acyclic at both levels:
 *
 *   1. workspace package -> workspace package
 *   2. source file -> source file, within a package
 *
 * Type-only cycles count. TypeScript erases them at runtime, which is exactly
 * why they survive unnoticed and still defeat anyone — human or agent — trying
 * to read the codebase in dependency order.
 */

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");
const baselinePath = join(repoRoot, "scripts", "module-graph-baseline.json");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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
    if (color.get(node) === WHITE) visit(node);
  }
  return cycles;
}

function packageGraph(): { nodes: string[]; edges: Map<string, Set<string>> } {
  const nodes: string[] = [];
  const edges = new Map<string, Set<string>>();
  const byName = new Map<string, string>();

  for (const entry of readdirSync(packagesRoot)) {
    const manifestPath = join(packagesRoot, entry, "package.json");
    try {
      statSync(manifestPath);
    } catch {
      continue;
    }
    const manifest = readJson<PackageJson>(manifestPath);
    if (!manifest.name) continue;
    byName.set(manifest.name, entry);
    nodes.push(manifest.name);
  }

  for (const name of nodes) {
    const manifest = readJson<PackageJson>(join(packagesRoot, byName.get(name)!, "package.json"));
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    edges.set(
      name,
      new Set(
        Object.entries(deps)
          .filter(([dep, range]) => range.startsWith("workspace:") && byName.has(dep))
          .map(([dep]) => dep),
      ),
    );
  }

  return { nodes, edges };
}

function* sourceFiles(directory: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield path;
    }
  }
}

function fileGraph(packageSrc: string): { nodes: string[]; edges: Map<string, Set<string>> } {
  const nodes = [...sourceFiles(packageSrc)];
  const known = new Set(nodes);
  const edges = new Map<string, Set<string>>();

  for (const file of nodes) {
    const source = readFileSync(file, "utf8");
    const targets = new Set<string>();
    for (const match of source.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
      const specifier = match[1]!;
      const resolved = resolve(dirname(file), specifier);
      for (const candidate of [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        join(resolved, "index.ts"),
      ]) {
        if (candidate !== file && known.has(candidate)) {
          targets.add(candidate);
          break;
        }
      }
    }
    edges.set(file, targets);
  }

  return { nodes, edges };
}

function main(): void {
  const found: string[] = [];

  const packages = packageGraph();
  for (const cycle of findCycles(packages.nodes, packages.edges)) {
    found.push(`package cycle: ${cycle.join(" -> ")}`);
  }

  for (const entry of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, entry, "src");
    try {
      statSync(src);
    } catch {
      continue;
    }
    const graph = fileGraph(src);
    for (const cycle of findCycles(graph.nodes, graph.edges)) {
      found.push(
        `module cycle in ${entry}: ${cycle.map((file) => relative(src, file)).join(" -> ")}`,
      );
    }
  }

  const baseline: string[] = (() => {
    try {
      return JSON.parse(readFileSync(baselinePath, "utf8")) as string[];
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
    for (const cycle of introduced) console.error(`  ${cycle}`);
    console.error(
      "\nCycles must be broken, not suppressed. The usual fix is to move the shared\n" +
        "declarations into a leaf module that both sides import. The baseline is a\n" +
        "ratchet for pre-existing debt and may only shrink.",
    );
    process.exit(1);
  }

  if (fixed.length > 0) {
    console.error(`${fixed.length} baselined cycle(s) are fixed. Run with --update-baseline:\n`);
    for (const cycle of fixed) console.error(`  ${cycle}`);
    process.exit(1);
  }

  console.log(
    `Module graph OK: ${packages.nodes.length} packages, no package cycles, ` +
      `${found.length} baselined module cycle(s) remaining.`,
  );
}

main();
