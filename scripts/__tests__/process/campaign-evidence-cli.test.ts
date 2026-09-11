import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../");
const scriptPath = join(repoRoot, "scripts", "campaign-evidence.ts");
const tsxPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runEvidence(
  argument: string | undefined,
  campaignRoot: string,
): { readonly status: number | null; readonly output: string } {
  const environment = { ...process.env };
  delete environment["SWEATPANTS_SPEC_INDEX"];
  environment["SWEATPANTS_CAMPAIGN_SPEC_ROOT"] = join(campaignRoot, "specs");
  environment["SWEATPANTS_CAMPAIGN_EVIDENCE_ROOT"] = join(campaignRoot, "evidence");
  const result = spawnSync(
    process.execPath,
    [tsxPath, scriptPath, ...(argument === undefined ? [] : [argument])],
    { cwd: repoRoot, env: environment, encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("campaign evidence CLI boundaries", () => {
  it("keeps ordinary evidence independent from campaign inputs", () => {
    const campaignRoot = mkdtempSync(join(tmpdir(), "sweatpants-campaign-inputs-"));
    try {
      const ordinary = runEvidence(undefined, campaignRoot);
      expect(ordinary.status).toBe(0);
      expect(ordinary.output).toContain("campaign evidence (permanent)");
      expect(ordinary.output).not.toContain("E8c");
      expect(ordinary.output).not.toContain("E11");
    } finally {
      rmSync(campaignRoot, { recursive: true, force: true });
    }
  });

  it("requires campaign inputs for explicit closure", () => {
    const campaignRoot = mkdtempSync(join(tmpdir(), "sweatpants-campaign-inputs-"));
    try {
      const closure = runEvidence("--closure", campaignRoot);
      expect(closure.status).toBe(1);
      expect(closure.output).toContain("FAIL E8c");
      expect(closure.output).toContain("FAIL E11");
      expect(closure.output).toContain("archive baseline not yet recorded");
    } finally {
      rmSync(campaignRoot, { recursive: true, force: true });
    }
  });

  it("rejects obsolete numeric cut arguments", () => {
    const campaignRoot = mkdtempSync(join(tmpdir(), "sweatpants-campaign-inputs-"));
    try {
      const invalid = runEvidence("2", campaignRoot);
      expect(invalid.status).toBe(2);
      expect(invalid.output).toContain("usage: pnpm check:evidence | pnpm check:evidence:closure");
    } finally {
      rmSync(campaignRoot, { recursive: true, force: true });
    }
  });
});
