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
    // workspace dependency permitted beneath this legacy aggregate. Zod,
    // framework, runtime, and Redis imports remain forbidden.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "@standard-schema/spec",
      "@sweatpants/durable-effects",
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
