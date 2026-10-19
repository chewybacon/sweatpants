import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("closure checks controlled campaign inputs and rejects missing or changed evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "campaign-evidence-"));
    const specs = join(root, "specs");
    const evidence = join(root, "evidence");
    const archive = join(specs, "archive");
    mkdirSync(archive, { recursive: true });
    mkdirSync(evidence);
    vi.stubEnv("SWEATPANTS_CAMPAIGN_SPEC_ROOT", specs);
    vi.stubEnv("SWEATPANTS_CAMPAIGN_EVIDENCE_ROOT", evidence);
    vi.resetModules();
    try {
      const { runChecks: checkFixture, directoryFingerprint } =
        await import("../campaign-evidence.ts");
      const missing = checkFixture("closure");
      expect(
        missing
          .filter((result) => !result.passed)
          .map((result) => result.id)
          .sort(),
      ).toEqual(["E11", "E8c"]);
      writeFileSync(join(specs, "boundaries-and-logs.md"), "# Case 2: ephemeral\n");
      writeFileSync(join(archive, "baseline.md"), "Archived campaign input\n");
      writeFileSync(
        join(evidence, "campaign-archive-baseline.json"),
        JSON.stringify({ fingerprint: directoryFingerprint(archive) }),
      );
      const permanent = checkFixture();
      const closure = checkFixture("closure");
      expect(closure.length).toBe(17);
      expect(closure.map((result) => result.id)).toEqual(
        expect.arrayContaining(permanent.map((result) => result.id)),
      );
      expect(closure.map((result) => result.id)).toEqual(expect.arrayContaining(["E8c", "E11"]));
      expect(closure.every((result) => result.passed)).toBe(true);
      writeFileSync(join(archive, "baseline.md"), "Changed campaign input\n");
      expect(checkFixture("closure").find((result) => result.id === "E11")?.passed).toBe(false);
      writeFileSync(join(specs, "boundaries-and-logs.md"), "# Case 2: obsolete\n");
      expect(checkFixture("closure").find((result) => result.id === "E8c")?.passed).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
