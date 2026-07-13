import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("session-contract package boundaries", () => {
  it("remains a framework-independent semantic leaf", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@noble/hashes",
      "effection",
    ]);

    const sourceFiles = [
      "canonical.ts",
      "contexts.ts",
      "crank.ts",
      "index.ts",
      "journal.ts",
      "projections.ts",
      "pulls.ts",
      "recovery.ts",
      "session.ts",
      "store.ts",
      "types.ts",
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
      expect(source, file).not.toContain("@sweatpants/framework");
      expect(source, file).not.toContain("@sweatpants/tool-runtime");
      expect(source, file).not.toContain(' from "redis"');
    }
  });
});
