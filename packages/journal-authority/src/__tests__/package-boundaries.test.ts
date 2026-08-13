import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("journal-authority package boundaries", () => {
  it("owns authority semantics without runtime-adapter dependencies", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // Journal Authority may depend on domain contracts, portable signing
    // primitives, the domain-agnostic durable storage kernel, and private Zod
    // schemas. No Host, tool-runtime, or Redis dependency is permitted.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "@standard-schema/spec",
      "@sweatpants/durable-effects",
      "@sweatpants/durable-execution",
      "@sweatpants/durable-storage-kernel",
      "@sweatpants/foundation",
      "effection",
      "zod",
    ]);

    // Authority semantics remain independent of concrete storage and hosting adapters.
    const sourceFiles = ["durable-apis.ts", "durable-authority.ts", "index.ts"];
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
      expect(source, file).not.toContain(["@sweatpants", "framework"].join("/"));
      expect(source, file).not.toContain("@sweatpants/tool-runtime");
      expect(source, file).not.toContain(' from "redis"');
    }
  });
});
