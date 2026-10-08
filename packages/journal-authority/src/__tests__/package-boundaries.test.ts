import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("journal-authority package boundaries", () => {
  it("owns authority semantics without runtime-adapter dependencies", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // Journal Authority may depend on domain contracts, portable signing/encoding
    // primitives, the domain-agnostic durable storage kernel, and private Zod
    // schemas. No Host, tool-runtime, or Redis dependency is permitted.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "@standard-schema/spec",
      "@sweatpants/durable-effects",
      "@sweatpants/durable-execution",
      "@sweatpants/durable-storage-kernel",
      "@sweatpants/foundation",
      "base64-js",
      "effection",
      "zod",
    ]);

    // Authority semantics remain independent of concrete storage and hosting adapters.
    const sourceFiles = [
      "workflow/driver-drive.ts",
      "decisions/authority-decisions.ts",
      "index.ts",
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
      expect(source, file).not.toContain(["@sweatpants", "framework"].join("/"));
      expect(source, file).not.toContain("@sweatpants/tool-runtime");
      expect(source, file).not.toContain(' from "redis"');
    }
  });

  it("keeps removed facades, raw shell backends, and the decision API off public exports", () => {
    const publicSources = ["index.ts", "api.ts"];
    const forbidden = [
      "DurableJournalAuthorityService",
      "InMemoryDurableJournalAuthority",
      "StoredDurableJournalAuthority",
      "createInMemoryDurableJournalAuthority",
      "createStoredDurableJournalAuthority",
      "AuthorityBackend",
      "StoredAuthorityBackend",
      "AuthorityTestBackend",
      "adaptAuthorityBackend",
      "installJournalAuthorityRuntime",
      "AuthorityDecisionApi",
      "decideAuthorityTransition",
      "AuthorityKernelReducer",
      "StoredShellDrivers",
      "adaptLegacyAuthorityContract",
    ];
    for (const file of publicSources) {
      const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
      for (const name of forbidden) {
        expect(source, `${file}:${name}`).not.toContain(name);
      }
    }
    const packageJson = readFileSync(resolve(packageRoot, "package.json"), "utf8");
    expect(packageJson).not.toContain("decision-api");
    expect(packageJson).not.toContain("decision-pipeline");
    expect(packageJson).not.toContain("durable-authority");
    expect(packageJson).not.toContain("stored-authority");
    for (const removed of [
      "durable-authority.ts",
      "durable-authority-types.ts",
      "authority-kernel.ts",
      "stored-authority.ts",
      "authority-backend-adapter.ts",
      "durable-apis.ts",
    ]) {
      expect(existsSync(resolve(packageRoot, "src", removed)), removed).toBe(false);
    }

    const decisionSource = readFileSync(
      resolve(packageRoot, "src", "decisions/authority-decisions.ts"),
      "utf8",
    );
    expect(decisionSource).not.toContain("AUTHORITY_DECISION_HISTORY");
    expect(decisionSource).not.toContain("readJournal");
    expect(decisionSource).not.toContain("JournalAuthorityPort");
    expect(decisionSource).not.toContain("ExecutionStore");
    expect(decisionSource).not.toContain("AuthorityKernelReducer");
    const decisionPipelineSource = readFileSync(
      resolve(packageRoot, "src", "decisions/decision-pipeline.ts"),
      "utf8",
    );
    expect(decisionPipelineSource).not.toContain("createApi");
    expect(decisionPipelineSource).not.toContain("authorityStateFromSnapshot");
    expect(decisionPipelineSource).not.toContain("evaluateSnapshotQuery");

    const journalSource = readFileSync(resolve(packageRoot, "src", "shell/journal.ts"), "utf8");
    expect(journalSource).not.toContain("StoredScenarioDriver");
    expect(journalSource).not.toContain("createStoredScenarioDriver");
    expect(journalSource).not.toContain("taskExecutionState");

    const directStateSource = readFileSync(
      resolve(packageRoot, "src", "state/authority-state.ts"),
      "utf8",
    );
    expect(directStateSource).not.toContain("AUTHORITY_DECISION_HISTORY");
    expect(directStateSource).not.toContain("readJournal");
  });
});
