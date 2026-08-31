import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Consumer-or-parked workspace hygiene gate (spec REQ-019/REQ-020).
 *
 * Scans every workspace member (`packages/*`, `apps/*`), counts source-level
 * consumers (non-test source files in other members importing the member's
 * package name), and fails when a zero-consumer member lacks an annotation in
 * the `.pi/specs/INDEX.md` member ledger. Ledger statuses: library, product,
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
  if (/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(base)) return true;
  return segments.some((segment) => TEST_SEGMENTS.has(segment));
}

function listSourceFiles(rootDir: string, dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".d.ts")) continue;
    const full = join(dir, entry);
    const relativePath = relative(rootDir, full).replaceAll("\\", "/");
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      files.push(...listSourceFiles(rootDir, full));
    } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      if (isTestPath(relativePath)) continue;
      files.push(full);
    }
  }
  return files;
}

function discoverMembers(root: string): PackageInfo[] {
  const members: PackageInfo[] = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry);
      const manifestPath = join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
      if (!manifest.name) continue;
      members.push({ dir, member: `${group}/${entry}`, name: manifest.name });
    }
  }
  return members;
}

const IMPORT_PATTERN = (name: string): RegExp =>
  new RegExp(`from\\s+["']${name.replaceAll("/", "\\/")}(\\/.*)?["']`);

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
      for (const [name, target] of byName) {
        if (target === member.member) continue;
        if (consumers.get(target)?.includes(member.member)) continue;
        if (IMPORT_PATTERN(name).test(source)) {
          consumers.get(target)?.push(member.member);
        }
      }
    }
  }
  return consumers;
}

/** Parses the `## Workspace member ledger` table from the spec index. */
export function parseMemberLedger(indexPath: string): Map<string, LedgerStatus> {
  const ledger = new Map<string, LedgerStatus>();
  if (!existsSync(indexPath)) return ledger;
  const content = readFileSync(indexPath, "utf8");
  const sectionStart = content.indexOf("## Workspace member ledger");
  if (sectionStart === -1) return ledger;
  const nextSection = content.indexOf("\n## ", sectionStart + 1);
  const section = content.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
  const valid = new Set(["library", "product", "docs", "parked", "infrastructure"]);
  for (const line of section.split("\n")) {
    const row = /^\\?\|\s*`([^`]+)`\s*\\?\|\s*(\w+)\s*\\?\|/.exec(line);
    if (row && valid.has(row[2])) {
      ledger.set(row[1], row[2] as LedgerStatus);
    }
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
    if (member.violation) lines.push(`  -> ${member.violation}`);
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
    process.env["SWEATPANTS_SPEC_INDEX"] ?? resolve(root, "..", ".pi", "specs", "INDEX.md");
  const report = scanWorkspace(root, ledgerPath);
  console.log(formatReport(report));
  if (report.violations.length > 0) process.exit(1);
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
