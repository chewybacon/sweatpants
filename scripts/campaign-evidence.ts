import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Campaign evidence script for the Code Is Spec pre-release simplification
 * (spec: .pi/specs/code-is-spec-simplification-spec.md).
 *
 * Deterministic, read-only name-search checks over the working tree. Each
 * check carries the requirements it verifies; campaign-only checks run during
 * explicit closure verification.
 * Permanent:    tsx scripts/campaign-evidence.ts
 * Closure:      tsx scripts/campaign-evidence.ts --closure
 *
 * The permanent invocation is the re-runnable form of the spec's negative
 * claims (NFR-003) and stays in the tree: it re-verifies that deleted
 * identities stay deleted (REQ-013) on every future run. Closure adds only the
 * campaign archive/reference checks.
 */

export type EvidenceMode = "permanent" | "closure";

interface CheckResult {
  readonly id: string;
  readonly reqs: readonly string[];
  readonly passed: boolean;
  readonly detail: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath =
  process.env["SWEATPANTS_SPEC_INDEX"] ?? join(repoRoot, "docs", "workspace", "INDEX.md");
const campaignSpecRoot =
  process.env["SWEATPANTS_CAMPAIGN_SPEC_ROOT"] ?? resolve(repoRoot, "..", ".pi", "specs");
const campaignEvidenceRoot =
  process.env["SWEATPANTS_CAMPAIGN_EVIDENCE_ROOT"] ?? resolve(repoRoot, "..", ".pi", "evidence");
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
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) {
        continue;
      }
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
    if (SELF_SCANNING.test(file) || HISTORICAL.test(file)) {
      continue;
    }
    const count = (readFileSync(file, "utf8").match(pattern) ?? []).length;
    if (count > 0) {
      hits.set(relative(repoRoot, file), count);
    }
  }
  return hits;
}

function describeHits(hits: Map<string, number>): string {
  if (hits.size === 0) {
    return "0 hits";
  }
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

function readLedger(): string {
  return existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
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

interface RegisteredCheck {
  readonly id: string;
  readonly run: () => CheckResult;
}

function check(id: string, reqs: readonly string[], body: CheckBody): RegisteredCheck {
  return {
    id,
    run: () => {
      try {
        const { passed, detail } = body();
        return { id, reqs, passed, detail };
      } catch (error) {
        return {
          id,
          reqs,
          passed: false,
          detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

const checks: readonly RegisteredCheck[] = [
  // ── Cut 1 — Orphans & governance ─────────────────────────────────────────
  check("E1a", ["REQ-006"], () => ({
    passed: !exists("packages/execution-store-redis"),
    detail: "packages/execution-store-redis absent",
  })),
  check("E1b", ["REQ-006"], () => {
    const hits = filesMatching(
      workspaceFiles().filter((file) => !file.includes("apps/yo-slides")),
      /execution-store-redis/,
    );
    return {
      passed: hits.size === 0,
      detail: `references to execution-store-redis: ${describeHits(hits)}`,
    };
  }),
  check("E2a", ["REQ-007"], () => ({
    passed: !exists("apps/hydra"),
    detail: "apps/hydra absent",
  })),
  check("E2b", ["REQ-007"], () => {
    const hits = filesMatching(
      workspaceFiles().filter((file) => !file.includes("apps/yo-slides")),
      /hydra-effection|apps\/hydra/,
    );
    return {
      passed: hits.size === 0,
      detail: `references to hydra outside docs-classified slides: ${describeHits(hits)}`,
    };
  }),
  check("E3", ["REQ-008"], () => {
    const slidesPresent =
      exists("apps/yo-slides/effection-team") &&
      exists("apps/yo-slides/principal-engineers") &&
      exists("apps/yo-slides/tech-leads");
    const ledger = readLedger();
    const annotated = /\|\s*`apps\/yo-slides`\s*\|\s*docs\s*\|/.test(ledger);
    return {
      passed: slidesPresent && annotated,
      detail: `slide dirs present=${slidesPresent}, ledger docs entry=${annotated}`,
    };
  }),
  check("E4", ["REQ-009"], () => {
    const pkg = exists("packages/workspace-lambda-microvm/package.json");
    const ledger = readLedger();
    const parked = /\|\s*`packages\/workspace-lambda-microvm`\s*\|\s*parked\s*\|/.test(ledger);
    const reaudit = /re-audit: when the experiment resumes/.test(ledger);
    return {
      passed: pkg && parked && reaudit,
      detail: `package present=${pkg}, park record=${parked}, re-audit condition=${reaudit}`,
    };
  }),
  check("E5", ["REQ-010"], () => {
    const shell = exists("apps/lambda-microvm-sandbox/package.json");
    const ledger = readLedger();
    const recorded = /\|\s*`apps\/lambda-microvm-sandbox`\s*\|\s*parked\s*\|/.test(ledger);
    return {
      passed: shell && recorded,
      detail: `shell present=${shell}, ledger record=${recorded}`,
    };
  }),
  check("E9", ["REQ-002", "REQ-013"], () => {
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
  check("E10", ["REQ-005", "NFR-004"], () => {
    const agents = existsSync(agentsDoc) ? readFileSync(agentsDoc, "utf8") : "";
    const rules = agents.includes("No-Sediment Rules");
    const expiry = agents.includes("first time an external user");
    const ledger = readLedger();
    const linked =
      /no-sediment standing rules.*AGENTS\.md|AGENTS\.md.*\(see "The No-Sediment Rules/.test(
        ledger,
      );
    return {
      passed: rules && expiry && linked,
      detail: `rules=${rules}, expiry=${expiry}, ledger link=${linked}`,
    };
  }),
  check("E11", ["REQ-018"], () => {
    const baselinePath = join(campaignEvidenceRoot, "campaign-archive-baseline.json");
    if (!existsSync(baselinePath)) {
      return {
        passed: false,
        detail: `archive baseline not yet recorded (${baselinePath})`,
      };
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { fingerprint: string };
    const archiveDir = join(campaignSpecRoot, "archive");
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
  check("E6", ["REQ-011", "REQ-001", "REQ-004"], () => {
    const hits = filesMatching(workspaceFiles(), /legacyForeign|detachedLegacy/);
    return {
      passed: hits.size === 0,
      detail: `legacy foreign regime references: ${describeHits(hits)}`,
    };
  }),
  check("E6b", ["REQ-011"], () => {
    const hits = filesMatching(workspaceFiles(), /kind:\s*"foreign"|"foreign-tool"/);
    return {
      passed: hits.size === 0,
      detail: `foreign descriptor/kind literals: ${describeHits(hits)}`,
    };
  }),

  // ── Cut 3 — Contract collapse ────────────────────────────────────────────
  check("E7", ["REQ-015", "REQ-014"], () => {
    const hits = filesMatching(workspaceFiles(), /resumable_handle|server_task/);
    return { passed: hits.size === 0, detail: `dead durability modes: ${describeHits(hits)}` };
  }),

  // ── Cut 4 — Vocabulary ───────────────────────────────────────────────────
  check("E8a", ["REQ-017"], () => {
    const renamed =
      exists("acceptance/__tests__/application-composition/command-retries.acceptance.test.ts") &&
      exists("apps/yo-chat/acceptance/book-flight-ephemeral-invariance.acceptance.test.ts");
    const old =
      exists("apps/yo-chat/acceptance/foreign-stale-elicit.acceptance.test.ts") ||
      exists("apps/yo-chat/acceptance/book-flight-foreign-invariance.acceptance.test.ts");
    return {
      passed: renamed && !old,
      detail: `ephemeral contract evidence present=${renamed}, old names gone=${!old}`,
    };
  }),
  check("E8b", ["REQ-017", "REQ-003"], () => {
    const hits = filesMatching(workspaceFiles(), /foreign_reference_lost/);
    return {
      passed: hits.size === 0,
      detail: `foreign_reference_lost references: ${describeHits(hits)}`,
    };
  }),
  check("E8c", ["REQ-017"], () => {
    const boundariesPath = join(campaignSpecRoot, "boundaries-and-logs.md");
    const doc = existsSync(boundariesPath) ? readFileSync(boundariesPath, "utf8") : "";
    const ephemeralCase2 =
      doc.includes("Case 2") &&
      /Case 2[^\n]*ephemeral/.test(doc) &&
      !doc.includes("foreign_reference_lost");
    return {
      passed: ephemeralCase2,
      detail: `boundaries-and-logs Case 2 aligned=${ephemeralCase2} (${boundariesPath})`,
    };
  }),
  check("E8d", ["REQ-017", "REQ-003"], () => {
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

const CLOSURE_CHECKS = new Set(["E8c", "E11"]);

export function runChecks(mode: EvidenceMode = "permanent"): readonly CheckResult[] {
  return checks
    .filter(({ id }) => mode === "closure" || !CLOSURE_CHECKS.has(id))
    .map(({ run }) => run());
}

function main(): void {
  const arg = process.argv[2];
  if (arg !== undefined && arg !== "--closure") {
    console.error("usage: pnpm check:evidence | pnpm check:evidence:closure");
    process.exitCode = 2;
    return;
  }
  const mode: EvidenceMode = arg === "--closure" ? "closure" : "permanent";
  const results = runChecks(mode);
  let failed = 0;
  for (const result of results) {
    const mark = result.passed ? "PASS" : "FAIL";
    if (!result.passed) {
      failed += 1;
    }
    console.log(`${mark} ${result.id} (${result.reqs.join(", ")}) — ${result.detail}`);
  }
  console.log(
    failed === 0
      ? `\ncampaign evidence (${mode}): all ${results.length} checks pass`
      : `\ncampaign evidence (${mode}): ${failed} of ${results.length} checks fail`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
