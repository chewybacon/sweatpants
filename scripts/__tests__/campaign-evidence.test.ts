import { describe, expect, it } from "vitest";
import { runChecks } from "../campaign-evidence.ts";

/**
 * The permanent evidence set is safe for every landing and uses only files in
 * the checkout. Closure adds the two checks that intentionally require the
 * external campaign archive/reference inputs.
 */

describe("campaign evidence script", () => {
  it("runs every permanent check without campaign-only checks", () => {
    const results = runChecks();
    expect(results.length).toBe(15);
    expect(results.map((result) => result.id)).not.toContain("E8c");
    expect(results.map((result) => result.id)).not.toContain("E11");
    expect(results.every((result) => result.passed)).toBe(true);
    for (const result of results) {
      expect(result.id).toMatch(/^E\d+\w*$/);
      expect(result.reqs.length).toBeGreaterThan(0);
      expect(typeof result.passed).toBe("boolean");
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it("closure explicitly includes permanent and campaign-only checks", () => {
    const permanent = runChecks();
    const closure = runChecks("closure");
    expect(closure.length).toBe(17);
    expect(closure.map((result) => result.id)).toEqual(
      expect.arrayContaining(permanent.map((result) => result.id)),
    );
    expect(closure.map((result) => result.id)).toEqual(expect.arrayContaining(["E8c", "E11"]));
    expect(closure.every((result) => result.passed)).toBe(true);
  });
});
