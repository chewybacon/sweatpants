import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Consumer-or-parked workspace hygiene gate (spec REQ-019/REQ-020).
 *
 * Scans every workspace member (`acceptance`, `packages/*`, `apps/*`), counts source-level
 * consumers (non-test source files in other members importing the member's
 * package name), and fails when a zero-consumer member lacks an annotation in
 * the `docs/workspace/INDEX.md` member ledger. Ledger statuses: library, product,
 * docs, parked, infrastructure. A `library` row on a zero-consumer member is
 * a stale ledger and fails the gate.
 */

export type LedgerStatus = "library" | "product" | "docs" | "parked" | "infrastructure";

export interface MemberReport {
  readonly member: string;
  readonly packageName: string;
  readonly consumerCount: number;
  readonly consumers: readonly string[];
  readonly ledgerStatus: LedgerStatus | null;
  readonly violation: string | null;
}

export interface HygieneReport {
  readonly root: string;
  readonly ledgerPath: string;
  readonly members: readonly MemberReport[];
  readonly violations: readonly MemberReport[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TEST_SEGMENTS = new Set(["__tests__", "tests", "e2e", "acceptance"]);
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".artifacts", ".cache"]);
const ANNOTATED_STATUSES: readonly LedgerStatus[] = ["product", "docs", "parked", "infrastructure"];

interface PackageInfo {
  readonly dir: string;
  readonly member: string;
  readonly name: string;
}

function isTestPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(base)) {
    return true;
  }
  return segments.some((segment) => TEST_SEGMENTS.has(segment));
}

function listSourceFiles(rootDir: string, dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".d.ts")) {
      continue;
    }
    const full = join(dir, entry);
    const relativePath = relative(rootDir, full).replaceAll("\\", "/");
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) {
        continue;
      }
      files.push(...listSourceFiles(rootDir, full));
    } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      if (isTestPath(relativePath)) {
        continue;
      }
      files.push(full);
    }
  }
  return files;
}

function discoverMembers(root: string): PackageInfo[] {
  const members: PackageInfo[] = [];
  const acceptanceDir = join(root, "acceptance");
  const acceptanceManifest = join(acceptanceDir, "package.json");
  if (existsSync(acceptanceManifest)) {
    const manifest = JSON.parse(readFileSync(acceptanceManifest, "utf8")) as { name?: string };
    if (manifest.name) {
      members.push({ dir: acceptanceDir, member: "acceptance", name: manifest.name });
    }
  }
  for (const group of ["packages", "apps"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) {
      continue;
    }
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry);
      const manifestPath = join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
      if (!manifest.name) {
        continue;
      }
      members.push({ dir, member: `${group}/${entry}`, name: manifest.name });
    }
  }
  return members;
}

function importedModuleNames(file: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      names.add(statement.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        names.add(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      names.add(statement.moduleReference.expression.text);
    }
  }
  return names;
}

function isPackageImport(moduleName: string, packageName: string): boolean {
  return moduleName === packageName || moduleName.startsWith(`${packageName}/`);
}

/** Source-level import graph over workspace members, excluding test files. */
export function buildConsumerMap(
  root: string,
  members: readonly PackageInfo[],
): Map<string, string[]> {
  const byName = new Map(members.map((member) => [member.name, member.member]));
  const consumers = new Map<string, string[]>(members.map((member) => [member.member, []]));
  for (const member of members) {
    for (const file of listSourceFiles(root, member.dir)) {
      const source = readFileSync(file, "utf8");
      for (const importedName of importedModuleNames(file, source)) {
        for (const [name, target] of byName) {
          if (target === member.member || !isPackageImport(importedName, name)) {
            continue;
          }
          if (!consumers.get(target)?.includes(member.member)) {
            consumers.get(target)?.push(member.member);
          }
        }
      }
    }
  }
  return consumers;
}

function ledgerError(indexPath: string, reason: string): Error {
  return new Error(`[workspace-hygiene] workspace ledger malformed: ${indexPath} (${reason})`);
}

/** Parses and validates the `## Workspace member ledger` table. */
export function parseMemberLedger(indexPath: string): Map<string, LedgerStatus> {
  if (!existsSync(indexPath)) {
    throw new Error(`[workspace-hygiene] workspace ledger missing: ${indexPath}`);
  }
  const content = readFileSync(indexPath, "utf8");
  const sectionStart = content.indexOf("## Workspace member ledger");
  if (sectionStart === -1) {
    throw ledgerError(indexPath, "missing `## Workspace member ledger` section");
  }
  const nextSection = content.indexOf("\n## ", sectionStart + 1);
  const section = content.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
  const valid = new Set(["library", "product", "docs", "parked", "infrastructure"]);
  const ledger = new Map<string, LedgerStatus>();
  let rowCount = 0;
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line === "## Workspace member ledger") {
      continue;
    }
    if (/^\|\s*:?-{3,}/.test(line)) {
      continue;
    }
    if (/^\|\s*Member\s*\|\s*Status\s*\|/i.test(line)) {
      continue;
    }
    if (!line.startsWith("|")) {
      continue;
    }
    const row = /^\|\s*`([^`]+)`\s*\|\s*([A-Za-z]+)\s*\|/.exec(line);
    if (!row) {
      throw ledgerError(indexPath, `invalid ledger row: ${line}`);
    }
    const [, member, status] = row;
    if (!valid.has(status)) {
      throw ledgerError(indexPath, `unknown status ${JSON.stringify(status)} for ${member}`);
    }
    if (ledger.has(member)) {
      throw ledgerError(indexPath, `duplicate member ${member}`);
    }
    ledger.set(member, status as LedgerStatus);
    rowCount += 1;
  }
  if (rowCount === 0) {
    throw ledgerError(indexPath, "member table has no data rows");
  }
  return ledger;
}

export function scanWorkspace(root: string, ledgerPath: string): HygieneReport {
  const members = discoverMembers(root);
  const consumers = buildConsumerMap(root, members);
  const ledger = parseMemberLedger(ledgerPath);
  const reports: MemberReport[] = members.map((member) => {
    const memberConsumers = consumers.get(member.member) ?? [];
    const consumerCount = memberConsumers.length;
    const ledgerStatus = ledger.get(member.member) ?? null;
    let violation: string | null = null;
    if (consumerCount === 0 && !ANNOTATED_STATUSES.includes(ledgerStatus as LedgerStatus)) {
      violation =
        ledgerStatus === "library" || ledgerStatus === null
          ? ledgerStatus === "library"
            ? "ledger says library but no source-level consumers found (stale ledger)"
            : "no ledger annotation (needs product | docs | parked | infrastructure)"
          : null;
    }
    return {
      member: member.member,
      packageName: member.name,
      consumerCount,
      consumers: memberConsumers,
      ledgerStatus,
      violation,
    };
  });
  for (const [member] of ledger) {
    if (!members.some((entry) => entry.member === member)) {
      reports.push({
        member,
        packageName: "",
        consumerCount: 0,
        consumers: [],
        ledgerStatus: ledger.get(member) ?? null,
        violation: "ledger lists a member that no longer exists in the workspace",
      });
    }
  }
  return {
    root,
    ledgerPath,
    members: reports,
    violations: reports.filter((report) => report.violation !== null),
  };
}

export function formatReport(report: HygieneReport): string {
  const lines: string[] = [];
  for (const member of report.members) {
    const status = member.violation
      ? "FAIL"
      : (member.ledgerStatus ?? (member.consumerCount > 0 ? "library" : "?"));
    lines.push(`${status.padEnd(15)} ${member.member} (consumers: ${member.consumerCount})`);
    if (member.violation) {
      lines.push(`  -> ${member.violation}`);
    }
  }
  if (report.violations.length > 0) {
    lines.push(
      `\nhygiene gate FAILED: ${report.violations.length} violating member(s); ` +
        `ledger: ${relative(report.root, report.ledgerPath)}`,
    );
  } else {
    lines.push(`\nhygiene gate passed for ${report.members.length} members`);
  }
  return lines.join("\n");
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const ledgerPath =
    process.env["SWEATPANTS_SPEC_INDEX"] ?? resolve(root, "docs", "workspace", "INDEX.md");
  try {
    const report = scanWorkspace(root, ledgerPath);
    console.log(formatReport(report));
    if (report.violations.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
