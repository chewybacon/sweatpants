import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sourceDirectory = new URL("./", import.meta.url);
const escapeHatchMarker = "scenario-escape-hatch:";

/**
 * Keep the acceptance suite in causal-order scenario form. A focused test may
 * use low-level promise barriers only when it carries an explicit rationale.
 */
describe("framework acceptance authoring style", () => {
  it("uses causal scenarios instead of pre-armed promise choreography", async () => {
    const names = (await readdir(sourceDirectory)).filter((name) =>
      name.endsWith(".acceptance.test.ts"),
    );
    expect(names.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const name of names) {
      const source = await readFile(new URL(name, sourceDirectory), "utf8");
      if (source.includes(escapeHatchMarker)) {
        continue;
      }
      if (!source.includes("withTestScenario")) {
        violations.push(`${name}: missing withTestScenario`);
      }
      for (const [label, pattern] of [
        ["withTestRig", /\bwithTestRig\b/],
        ["expectRequest", /\.expectRequest\s*\(/],
        ["nested await", /await\s*\(\s*await\b/],
        ["promise race", /Promise\.race\s*\(/],
      ] as const) {
        if (pattern.test(source)) {
          violations.push(`${name}: prohibited ${label} choreography`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
