import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("session-contract package boundaries", () => {
  it("remains a framework-independent semantic leaf", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // The legacy aggregate may depend on the new durable-execution hub only
    // while its ProgramRuntime/context consumers are being dissolved. No
    // framework, tool-runtime, Zod, or Redis dependency is permitted.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "@standard-schema/spec",
      "@sweatpants/durable-effects",
      "@sweatpants/durable-execution",
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
