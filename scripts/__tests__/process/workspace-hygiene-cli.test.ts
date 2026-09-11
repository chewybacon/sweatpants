import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../");
const cliPath = join(repoRoot, "scripts", "workspace-hygiene.ts");
const tsxPath = join(repoRoot, "node_modules", ".bin", "tsx");

function createCurrentSnapshot(): string {
  const snapshot = mkdtempSync(join(tmpdir(), "sweatpants-hygiene-checkout-"));
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repoRoot,
  })
    .toString()
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith(".pi/"));
  for (const file of files) {
    const source = join(repoRoot, file);
    if (!existsSync(source)) continue;
    const destination = join(snapshot, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  symlinkSync(join(repoRoot, "node_modules"), join(snapshot, "node_modules"), "dir");
  return snapshot;
}

function runCli(snapshot: string): { readonly status: number | null; readonly output: string } {
  const environment = { ...process.env };
  delete environment["SWEATPANTS_SPEC_INDEX"];
  const result = spawnSync(tsxPath, ["scripts/workspace-hygiene.ts"], {
    cwd: snapshot,
    env: environment,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("workspace hygiene CLI in a clean checkout", () => {
  it("uses tracked inputs, fails clearly on bad ledgers, and catches an orphan", () => {
    const snapshot = createCurrentSnapshot();
    try {
      const ledgerPath = join(snapshot, "docs", "workspace", "INDEX.md");
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(join(snapshot, ".pi"))).toBe(false);
      const validLedger = readFileSync(ledgerPath);

      const valid = runCli(snapshot);
      expect(valid.status).toBe(0);
      expect(valid.output).toContain("hygiene gate passed");

      rmSync(ledgerPath);
      const missing = runCli(snapshot);
      expect(missing.status).toBe(1);
      expect(missing.output).toContain("workspace ledger missing");
      expect(missing.output).toContain(ledgerPath);

      writeFileSync(
        ledgerPath,
        "# Workspace member ledger\n\n" +
          "## Workspace member ledger\n\n" +
          "| Member | Status | Note |\n|---|---|---|\n" +
          "| `packages/agent-host` | unknown | invalid status |\n",
      );
      const malformed = runCli(snapshot);
      expect(malformed.status).toBe(1);
      expect(malformed.output).toContain("workspace ledger malformed");
      expect(malformed.output).toContain("unknown status");
      expect(malformed.output).toContain(ledgerPath);

      writeFileSync(ledgerPath, validLedger);
      mkdirSync(join(snapshot, "packages", "orphan", "src"), { recursive: true });
      writeFileSync(
        join(snapshot, "packages", "orphan", "package.json"),
        JSON.stringify({ name: "@fixture/orphan" }),
      );
      writeFileSync(
        join(snapshot, "packages", "orphan", "src", "index.ts"),
        "export const orphan = 1;\n",
      );
      const orphan = runCli(snapshot);
      expect(orphan.status).toBe(1);
      expect(orphan.output).toContain("packages/orphan (consumers: 0)");
      expect(orphan.output).toContain("no ledger annotation");
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });
});
