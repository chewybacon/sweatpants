import { describe, expect, it } from "vitest";
import { runChecks } from "../campaign-evidence.ts";

/**
 * Verifies the campaign evidence script's behavior on the real tree (test
 * plan Layer A). Cut-1 checks must pass from Cut 1 onward; later-cut checks
 * are exercised as their cuts land — this suite runs through
 * `pnpm test:tooling`, so it asserts the checks are well-formed and that the
 * Cut-1 set (governance + orphans) currently passes. Post-campaign, the full
 * run is wired into `pnpm land` via check:evidence.
 */

describe("campaign evidence script", () => {
  it("emits a verdict for every check, tagged with cut and requirements", () => {
    const results = runChecks();
    expect(results.length).toBeGreaterThanOrEqual(15);
    for (const result of results) {
      expect(result.id).toMatch(/^E\d+\w*$/);
      expect(result.reqs.length).toBeGreaterThan(0);
      expect([1, 2, 3, 4]).toContain(result.cut);
      expect(typeof result.passed).toBe("boolean");
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it("Cut 1 closure set passes: orphans deleted, ledger annotated, rules documented", () => {
    const results = runChecks(1);
    const failures = results.filter((result) => !result.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  });

  it("later-cut checks are present but not required until their cut lands", () => {
    const results = runChecks();
    const cuts = new Set(results.map((result) => result.cut));
    expect(cuts).toEqual(new Set([1, 2, 3, 4]));
  });
});
