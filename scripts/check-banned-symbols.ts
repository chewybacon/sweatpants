#!/usr/bin/env tsx
/**
 * Grep gates for unified-tool-types (REQ-026/027).
 * Fails non-zero if banned patterns appear outside allowlisted paths.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

type Gate = {
  name: string;
  pattern: string;
  paths: string[];
  /** Paths/files to exclude from matches (substring match on file path) */
  exclude?: string[];
};

const gates: Gate[] = [
  {
    name: "deleted-result-types",
    pattern: "CoreElicitResult|RawElicitResult|RawSampleResult\\b",
    paths: ["packages", "apps"],
  },
  {
    name: "dialect-shims",
    pattern: "legacyContextData|spreadContext",
    paths: ["packages", "apps"],
  },
  {
    name: "full-cutover-shims",
    pattern:
      "@deprecated|legacyMergeKey|x-model-context|--x-elicit-context|pluginSamplingProvider|REFERENCE_REVIEWER_CHAT_AGENT|:elicit:|:sample:",
    paths: [
      "packages/core/src",
      "packages/session-contract/src",
      "packages/durable-streams/src",
      "packages/framework/src",
      "packages/tool-runtime-local/src",
      "packages/tool-runtime-agentcore/src",
      "packages/elicit-context/src",
      "apps/yo-chat/src",
      "apps/a2a-review/src",
      "apps/agentcore-tool-session-tracer/src",
    ],
  },
  {
    name: "as-never-welds",
    pattern: "as never",
    paths: [
      "packages/core/src/tool",
      "packages/core/src/builtins",
      "packages/framework/src/lib/chat/mcp-tools",
      "packages/tool-runtime-local/src",
      "packages/tool-runtime-agentcore/src",
      "apps/yo-chat/src/server",
    ],
    // Negative type tests deliberately construct invalid values with `as never`.
    exclude: ["__tests__"],
  },
  {
    name: "call-site-casts",
    pattern: "as LocalSessionTool|as AgentCoreMcpTool|as ElicitResult\\b",
    paths: ["apps", "packages"],
  },
  {
    name: "a2a-authoring-unsound-welds",
    // Journal/wire values must cross these boundaries through validated
    // decoders (normalizeChatTurnInput, decodePinnedProgramCatalog,
    // assertJson), never through as-unknown-as welds.
    pattern: "as unknown as",
    paths: [
      "packages/framework/src/server/standard-a2a-host.ts",
      "packages/framework/src/lib/chat/authoring/program.ts",
    ],
  },
  {
    name: "inline-type-imports",
    // Inline `import("@sweatpants/...")` type references hide dependencies and
    // resolve outside the module graph — use top-level `import type` instead.
    pattern: 'import\\("@sweatpants',
    paths: [
      "packages/core/src",
      "packages/framework/src",
      "packages/tool-runtime-local/src",
      "packages/tool-runtime-agentcore/src",
      "packages/elicit-context/src",
      "apps/yo-chat/src",
      "apps/yo-mcp/src",
    ],
    // Dynamic runtime `await import(...)` in tests is legitimate; the gate
    // targets inline type references in production sources.
    exclude: ["__tests__", ".test.ts"],
  },
  {
    name: "mcp-runtime-dual-dispatch",
    pattern: "isCanonicalCoreRuntimeTool",
    paths: ["packages", "apps"],
  },
  {
    name: "deleted-fold-runtime",
    pattern:
      "spawnFoldDriver|fold-driver|runFoldTurn|resumeSuspendedCallBatch|reattachCall|waitForLogChange|call_batch|CheckpointRecord|FoldSession",
    paths: ["packages/session-contract/src", "packages/framework/src/handler/durable"],
  },
  {
    name: "effection-native-durable-cutover",
    pattern:
      "DurableProgramGenerator|createLocalGeneratorDriver|LEGACY_MODEL_SAMPLE_EFFECT|workspace-effects\\.ts|\\.program\\([^\\n]*\\)\\.next\\(",
    paths: ["packages", "apps"],
  },
  {
    name: "timer-polled-idle-runtime",
    pattern: "sleep\\(|setInterval\\(|setTimeout\\(",
    paths: [
      "packages/session-contract/src",
      "packages/tool-runtime-local/src",
      "packages/framework/src/handler/durable",
    ],
    // Durable clock.sleep is an authoring operation that reserves a wait pull;
    // it does not call an Effection or platform timer in the crank.
    exclude: [
      "__tests__",
      "packages/session-contract/src/durable-authoring-types.ts",
      "packages/session-contract/src/authoring.ts",
    ],
  },
];

function runGate(gate: Gate): string[] {
  const pathArgs = gate.paths.filter((p) => existsSync(p)).join(" ");
  if (!pathArgs) return [];
  try {
    const out = execSync(
      `rg -n --glob '!**/dist/**' --glob '!**/node_modules/**' -e '${gate.pattern}' ${pathArgs} || true`,
      { encoding: "utf8", shell: "/bin/bash" },
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((line) => !(gate.exclude ?? []).some((ex) => line.includes(ex)));
  } catch {
    return [];
  }
}

let failed = 0;
for (const gate of gates) {
  const hits = runGate(gate);
  if (hits.length) {
    failed++;
    console.error(`\n[FAIL] gate ${gate.name} (${hits.length} hits):`);
    for (const h of hits.slice(0, 30)) console.error("  " + h);
    if (hits.length > 30) console.error(`  ... +${hits.length - 30} more`);
  } else {
    console.log(`[ok] ${gate.name}`);
  }
}

if (failed) {
  console.error(`\n${failed} gate(s) failed`);
  process.exit(1);
}
console.log("\nAll banned-symbol gates passed");
