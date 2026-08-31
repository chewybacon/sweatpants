import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Campaign evidence script for the Code Is Spec pre-release simplification
 * (spec: .pi/specs/code-is-spec-simplification-spec.md).
 *
 * Deterministic, read-only name-search checks over the working tree. Each
 * check carries the spec requirements and the cut whose closure it gates.
 * Run all:      tsx scripts/campaign-evidence.ts
 * Run one cut:  tsx scripts/campaign-evidence.ts 2
 *
 * The script is the re-runnable form of the spec's negative claims (NFR-003)
 * and stays in the tree permanently: it re-verifies that deleted identities
 * stay deleted (REQ-013) on every future run.
 */

type Cut = 1 | 2 | 3 | 4;

interface CheckResult {
  readonly id: string;
  readonly reqs: readonly string[];
  readonly cut: Cut;
  readonly passed: boolean;
  readonly detail: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specIndexDefault = resolve(repoRoot, "..", ".pi", "specs", "INDEX.md");
const specIndex = process.env["SWEATPANTS_SPEC_INDEX"] ?? specIndexDefault;
const agentsDoc = join(repoRoot, "AGENTS.md");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".json", ".yaml", ".md", ".mjs"]);
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".artifacts", ".cache", ".git"]);
/** The evidence script and its test carry pattern literals by construction; the
 * reset-policy test crafts the pre-cutover kind as its fixture (REQ-012). */
const SELF_SCANNING = /campaign-evidence|journal-reset\.test|durability-contract\.test/;
/** Historical records (landing notes, landed-spec mirrors, point-in-time
 * findings, generated drizzle metadata) are exempt from scans. */
const HISTORICAL =
  /docs[\\/]landing|docs[\\/]architecture[\\/]specs|drizzle[\\/]|FRAMEWORK-DX-FINDINGS/;

function listFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      files.push(...listFiles(full));
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      files.push(full);
    }
  }
  return files;
}

/** Workspace sources: packages/apps source trees, acceptance, e2e, configs, scripts, policies. */
function workspaceFiles(): string[] {
  const roots = [
    join(repoRoot, "packages"),
    join(repoRoot, "apps"),
    join(repoRoot, "scripts"),
    join(repoRoot, "policies"),
    join(repoRoot, "protocols"),
    join(repoRoot, "specs"),
    join(repoRoot, "docs"),
    join(repoRoot, "package.json"),
    join(repoRoot, "pnpm-workspace.yaml"),
    join(repoRoot, "pnpm-lock.yaml"),
    join(repoRoot, "tsconfig.json"),
    join(repoRoot, "vitest.scripts.config.ts"),
    join(repoRoot, "AGENTS.md"),
  ];
  return roots.flatMap((root) => (statSync(root).isDirectory() ? listFiles(root) : [root]));
}

function filesMatching(files: readonly string[], pattern: RegExp): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of files) {
    if (SELF_SCANNING.test(file) || HISTORICAL.test(file)) continue;
    const count = (readFileSync(file, "utf8").match(pattern) ?? []).length;
    if (count > 0) hits.set(relative(repoRoot, file), count);
  }
  return hits;
}

function describeHits(hits: Map<string, number>): string {
  if (hits.size === 0) return "0 hits";
  return `${hits.size} file(s): ${[...hits.entries()]
    .slice(0, 5)
    .map(([f, c]) => `${f}(${c})`)
    .join(", ")}${hits.size > 5 ? ", ..." : ""}`;
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function readSpecIndex(): string {
  return existsSync(specIndex) ? readFileSync(specIndex, "utf8") : "";
}

/** SHA-256 content fingerprint of every file under a directory. */
export function directoryFingerprint(dir: string): string {
  const entries = listFiles(dir)
    .map(
      (file) =>
        `${relative(dir, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    )
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

type CheckBody = () => { passed: boolean; detail: string };

function check(id: string, reqs: readonly string[], cut: Cut, body: CheckBody): () => CheckResult {
  return () => {
    try {
      const { passed, detail } = body();
      return { id, reqs, cut, passed, detail };
    } catch (error) {
      return {
        id,
        reqs,
        cut,
        passed: false,
        detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

const checks: readonly (() => CheckResult)[] = [
  // ── Cut 1 — Orphans & governance ─────────────────────────────────────────
  check("E1a", ["REQ-006"], 1, () => ({
    passed: !exists("packages/execution-store-redis"),
    detail: "packages/execution-store-redis absent",
  })),
  check("E1b", ["REQ-006"], 1, () => {
    const hits = filesMatching(
      workspaceFiles().filter((file) => !file.includes("apps/yo-slides")),
      /execution-store-redis/,
    );
    return {
      passed: hits.size === 0,
      detail: `references to execution-store-redis: ${describeHits(hits)}`,
    };
  }),
  check("E2a", ["REQ-007"], 1, () => ({
    passed: !exists("apps/hydra"),
    detail: "apps/hydra absent",
  })),
  check("E2b", ["REQ-007"], 1, () => {
    const hits = filesMatching(
      workspaceFiles().filter((file) => !file.includes("apps/yo-slides")),
      /hydra-effection|apps\/hydra/,
    );
    return {
      passed: hits.size === 0,
      detail: `references to hydra outside docs-classified slides: ${describeHits(hits)}`,
    };
  }),
  check("E3", ["REQ-008"], 1, () => {
    const slidesPresent =
      exists("apps/yo-slides/effection-team") &&
      exists("apps/yo-slides/principal-engineers") &&
      exists("apps/yo-slides/tech-leads");
    const ledger = readSpecIndex();
    const annotated = /\|\s*`apps\/yo-slides`\s*\|\s*docs\s*\|/.test(ledger);
    return {
      passed: slidesPresent && annotated,
      detail: `slide dirs present=${slidesPresent}, ledger docs entry=${annotated}`,
    };
  }),
  check("E4", ["REQ-009"], 1, () => {
    const pkg = exists("packages/workspace-lambda-microvm/package.json");
    const ledger = readSpecIndex();
    const parked = /\|\s*`packages\/workspace-lambda-microvm`\s*\|\s*parked\s*\|/.test(ledger);
    const reaudit = /re-audit: when the experiment resumes/.test(ledger);
    return {
      passed: pkg && parked && reaudit,
      detail: `package present=${pkg}, park record=${parked}, re-audit condition=${reaudit}`,
    };
  }),
  check("E5", ["REQ-010"], 1, () => {
    const shell = exists("apps/lambda-microvm-sandbox/package.json");
    const ledger = readSpecIndex();
    const recorded = /\|\s*`apps\/lambda-microvm-sandbox`\s*\|\s*parked\s*\|/.test(ledger);
    return {
      passed: shell && recorded,
      detail: `shell present=${shell}, ledger record=${recorded}`,
    };
  }),
  check("E9", ["REQ-002", "REQ-013"], 1, () => {
    const srcTrees = [
      ...listFiles(join(repoRoot, "packages")),
      ...listFiles(join(repoRoot, "apps")),
    ].filter(
      (file) => file.includes("src/") && !file.includes("node_modules") && !file.includes("dist"),
    );
    const hits = filesMatching(srcTrees, /@deprecated/);
    return {
      passed: hits.size === 0,
      detail: `@deprecated markers in member sources: ${describeHits(hits)}`,
    };
  }),
  check("E10", ["REQ-005", "NFR-004"], 1, () => {
    const agents = existsSync(agentsDoc) ? readFileSync(agentsDoc, "utf8") : "";
    const rules = agents.includes("No-Sediment Rules");
    const expiry = agents.includes("first time an external user");
    const ledger = readSpecIndex();
    const linked =
      /no-sediment standing rules.*AGENTS\.md|AGENTS\.md.*\(see "The No-Sediment Rules/.test(
        ledger,
      );
    return {
      passed: rules && expiry && linked,
      detail: `rules=${rules}, expiry=${expiry}, ledger link=${linked}`,
    };
  }),
  check("E11", ["REQ-018"], 1, () => {
    const baselinePath = resolve(
      repoRoot,
      "..",
      ".pi",
      "evidence",
      "campaign-archive-baseline.json",
    );
    if (!existsSync(baselinePath)) {
      return {
        passed: false,
        detail: "archive baseline not yet recorded (.pi/evidence/campaign-archive-baseline.json)",
      };
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { fingerprint: string };
    const archiveDir = resolve(repoRoot, "..", ".pi", "specs", "archive");
    const current = directoryFingerprint(archiveDir);
    return {
      passed: current === baseline.fingerprint,
      detail:
        current === baseline.fingerprint
          ? "archive unchanged since campaign start"
          : "archive content changed since campaign start",
    };
  }),

  // ── Cut 2 — Legacy regime ────────────────────────────────────────────────
  check("E6", ["REQ-011", "REQ-001", "REQ-004"], 2, () => {
    const hits = filesMatching(workspaceFiles(), /legacyForeign|detachedLegacy/);
    return {
      passed: hits.size === 0,
      detail: `legacy foreign regime references: ${describeHits(hits)}`,
    };
  }),
  check("E6b", ["REQ-011"], 2, () => {
    const hits = filesMatching(workspaceFiles(), /kind:\s*"foreign"|"foreign-tool"/);
    return {
      passed: hits.size === 0,
      detail: `foreign descriptor/kind literals: ${describeHits(hits)}`,
    };
  }),

  // ── Cut 3 — Contract collapse ────────────────────────────────────────────
  check("E7", ["REQ-015", "REQ-014"], 3, () => {
    const hits = filesMatching(workspaceFiles(), /resumable_handle|server_task/);
    return { passed: hits.size === 0, detail: `dead durability modes: ${describeHits(hits)}` };
  }),

  // ── Cut 4 — Vocabulary ───────────────────────────────────────────────────
  check("E8a", ["REQ-017"], 4, () => {
    const renamed =
      exists("apps/yo-chat/acceptance/ephemeral-stale-elicit.acceptance.test.ts") &&
      exists("apps/yo-chat/acceptance/book-flight-ephemeral-invariance.acceptance.test.ts");
    const old =
      exists("apps/yo-chat/acceptance/foreign-stale-elicit.acceptance.test.ts") ||
      exists("apps/yo-chat/acceptance/book-flight-foreign-invariance.acceptance.test.ts");
    return {
      passed: renamed && !old,
      detail: `renamed tests present=${renamed}, old names gone=${!old}`,
    };
  }),
  check("E8b", ["REQ-017", "REQ-003"], 4, () => {
    const hits = filesMatching(workspaceFiles(), /foreign_reference_lost/);
    return {
      passed: hits.size === 0,
      detail: `foreign_reference_lost references: ${describeHits(hits)}`,
    };
  }),
  check("E8c", ["REQ-017"], 4, () => {
    const doc = existsSync(specIndex.replace(/INDEX\.md$/, "boundaries-and-logs.md"))
      ? readFileSync(specIndex.replace(/INDEX\.md$/, "boundaries-and-logs.md"), "utf8")
      : "";
    const ephemeralCase2 =
      doc.includes("Case 2") &&
      /Case 2[^\n]*ephemeral/.test(doc) &&
      !doc.includes("foreign_reference_lost");
    return {
      passed: ephemeralCase2,
      detail: `boundaries-and-logs Case 2 aligned=${ephemeralCase2}`,
    };
  }),
  check("E8d", ["REQ-017", "REQ-003"], 4, () => {
    const hits = filesMatching(
      workspaceFiles(),
      /foreign_tool_|foreign_driver_|foreign_session_|foreign_continuation_|foreign_sampling_|foreign_ask_|foreign_result_|foreign_elicit_|foreign_response_|foreignKey|foreignTool|foreignRoute|foreignDriver|foreign\.tool\.|foreign_input|foreign-tool-adapter/,
    );
    return {
      passed: hits.size === 0,
      detail: `foreign vocabulary identifiers: ${describeHits(hits)}`,
    };
  }),
];

export function runChecks(filterCut?: Cut): readonly CheckResult[] {
  return checks
    .map((run) => run())
    .filter((result) => filterCut === undefined || result.cut <= filterCut);
}

function main(): void {
  const arg = process.argv[2];
  const filterCut = arg === undefined ? undefined : (Number(arg) as Cut);
  const results = runChecks(filterCut);
  let failed = 0;
  for (const result of results) {
    const mark = result.passed ? "PASS" : "FAIL";
    if (!result.passed) failed += 1;
    console.log(
      `${mark} [cut ${result.cut}] ${result.id} (${result.reqs.join(", ")}) — ${result.detail}`,
    );
  }
  console.log(
    failed === 0
      ? `\ncampaign evidence: all ${results.length} checks pass${filterCut ? ` through cut ${filterCut}` : ""}`
      : `\ncampaign evidence: ${failed} of ${results.length} checks fail${filterCut ? ` through cut ${filterCut}` : ""}`,
  );
  if (failed > 0) process.exit(1);
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
