import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatReport, scanWorkspace } from "../workspace-hygiene.ts";

/**
 * Behavioral tests for the consumer-or-parked hygiene gate (spec REQ-019/020,
 * test plan TC-017..TC-020). Fixture workspaces are synthetic; the final case
 * scans the real tree read-only and must pass once all cuts land.
 */

const roots: string[] = [];

function makeWorkspace(): string {
  const root = join(tmpdir(), `hygiene-fixture-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  mkdirSync(join(root, "packages", "real", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "orphan", "src"), { recursive: true });
  mkdirSync(join(root, ".pi", "specs"), { recursive: true });
  writeFileSync(
    join(root, "packages", "real", "package.json"),
    JSON.stringify({ name: "@fixture/real" }),
  );
  writeFileSync(join(root, "packages", "real", "src", "index.ts"), "export const real = true;\n");
  writeFileSync(
    join(root, "packages", "orphan", "package.json"),
    JSON.stringify({ name: "@fixture/orphan" }),
  );
  writeFileSync(join(root, "packages", "orphan", "src", "index.ts"), "export const orphan = 1;\n");
  writeFileSync(
    root + "/.pi/specs/INDEX.md",
    "# Specs Index\n\n## Workspace member ledger\n\n| Member | Status | Note |\n|---|---|---|\n| `packages/real` | product | fixture endpoint |\n",
  );
  return root;
}

function ledgerWith(root: string, rows: string): void {
  writeFileSync(
    join(root, ".pi", "specs", "INDEX.md"),
    `# Specs Index\n\n## Workspace member ledger\n\n| Member | Status | Note |\n|---|---|---|\n| \`packages/real\` | product | fixture endpoint |\n${rows}`,
  );
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("workspace hygiene gate", () => {
  it("TC-017: fails on a synthetic orphan, naming member and missing annotation", () => {
    const root = makeWorkspace();
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.member).toBe("packages/orphan");
    expect(report.violations[0]?.consumerCount).toBe(0);
    expect(report.violations[0]?.violation).toContain("no ledger annotation");
    expect(formatReport(report)).toContain("packages/orphan");
  });

  it("TC-017: does not flag the member that consumes the orphan", () => {
    const root = makeWorkspace();
    writeFileSync(
      join(root, "packages", "real", "src", "index.ts"),
      'import { orphan } from "@fixture/orphan";\nexport const real = orphan;\n',
    );
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    const real = report.members.find((member) => member.member === "packages/real");
    expect(real?.violation).toBeNull();
  });

  it("TC-019: a docs annotation in the ledger alone flips the verdict", () => {
    const root = makeWorkspace();
    ledgerWith(root, "| `packages/orphan` | docs | slide decks for audiences |\n");
    let report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    expect(report.violations).toHaveLength(0);
    ledgerWith(root, "");
    report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    expect(report.violations).toHaveLength(1);
  });

  it("TC-019: a park record with re-audit condition satisfies the gate", () => {
    const root = makeWorkspace();
    ledgerWith(
      root,
      "| `packages/orphan` | parked | experiment thread; re-audit: gains a real consumer or is deleted |\n",
    );
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    expect(report.violations).toHaveLength(0);
  });

  it("TC-020: test-only consumption does not count as consumption", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, "packages", "orphan", "src", "__tests__"), { recursive: true });
    writeFileSync(
      join(root, "packages", "orphan", "src", "__tests__", "orphan.test.ts"),
      'import { orphan } from "@fixture/orphan";\n',
    );
    mkdirSync(join(root, "packages", "real", "src", "acceptance"), { recursive: true });
    writeFileSync(
      join(root, "packages", "real", "src", "acceptance", "suite.acceptance.test.ts"),
      'import { orphan } from "@fixture/orphan";\n',
    );
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    const orphan = report.members.find((member) => member.member === "packages/orphan");
    expect(orphan?.consumerCount).toBe(0);
    expect(orphan?.violation).not.toBeNull();
  });

  it("fails on a stale library row (zero consumers but marked library)", () => {
    const root = makeWorkspace();
    ledgerWith(root, "| `packages/orphan` | library | |\n");
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    expect(report.violations[0]?.violation).toContain("stale ledger");
  });

  it("fails on a ledger row for a member that no longer exists", () => {
    const root = makeWorkspace();
    ledgerWith(root, "| `packages/ghost` | parked | gone |\n");
    const report = scanWorkspace(root, join(root, ".pi", "specs", "INDEX.md"));
    const ghost = report.violations.find((member) => member.member === "packages/ghost");
    expect(ghost?.violation).toContain("no longer exists");
  });

  it("TC-018: the real workspace passes with its ledger annotations", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const ledgerPath = join(repoRoot, "..", ".pi", "specs", "INDEX.md");
    const report = scanWorkspace(repoRoot, ledgerPath);
    expect(report.violations, formatReport(report)).toHaveLength(0);
  });
});
