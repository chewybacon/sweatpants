import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("session-contract package boundaries", () => {
  it("remains a framework-independent semantic leaf", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // DR-043/DR-054: the Phase 1 extraction makes durable-effects the only
    // domain-bearing workspace dependency permitted beneath this legacy
    // aggregate. DR-042/REQ-042 additionally permit foundation, which carries
    // portable composition primitives (canonical JSON, hashing, definePort)
    // and no domain nouns, so depending on it cannot reintroduce a cycle.
    // Zod, framework, runtime, and Redis imports remain forbidden.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "@standard-schema/spec",
      "@sweatpants/durable-effects",
      "@sweatpants/foundation",
      "effection",
    ]);

    const sourceFiles = [
      "authoring.ts",
      "canonical.ts",
      "durable-apis.ts",
      "durable-authority.ts",
      "durable-types.ts",
      "index.ts",
      "program-driver.ts",
      "schema-descriptor.ts",
      "schema-registry.ts",
      "types.ts",
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
      expect(source, file).not.toContain("@sweatpants/framework");
      expect(source, file).not.toContain("@sweatpants/tool-runtime");
      expect(source, file).not.toContain(' from "redis"');
      expect(source, file).not.toContain(' from "zod"');
    }
  });
});
