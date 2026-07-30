import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escapeHatch = /boundary-simulator-escape-hatch:\s*(.{20,})/u;

export interface AcceptanceBoundaryViolation {
  readonly file: string;
  readonly rule: "static-module-mock" | "mock-provider" | "test-internal-import";
  readonly detail: string;
}

const prohibited: ReadonlyArray<{
  rule: AcceptanceBoundaryViolation["rule"];
  pattern: RegExp;
  detail: string;
}> = [
  {
    rule: "static-module-mock",
    pattern: /\bvi\.(?:mock|doMock)\s*\(/u,
    detail: "acceptance tests drive installed boundaries; they do not replace modules",
  },
  {
    rule: "mock-provider",
    pattern: /\b(?:createMockProvider|mockPiStream|Fake[A-Za-z]*(?:Provider|Client))\b/u,
    detail: "external protocols use a simulator rather than a hand-built provider/client",
  },
  {
    rule: "test-internal-import",
    pattern: /(?:from\s+|import\s*\()["'][^"']*\/__tests__\/[^"']*["']/u,
    detail: "acceptance tests do not import package-private unit-test harnesses",
  },
];

function filesBelow(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist" && entry !== ".artifacts") {
        files.push(...filesBelow(path));
      }
    } else if (entry.endsWith(".acceptance.test.ts") || entry.endsWith(".acceptance.test.tsx")) {
      files.push(path);
    }
  }
  return files;
}

export function inspectAcceptanceBoundarySource(
  source: string,
  file = "<source>",
): AcceptanceBoundaryViolation[] {
  if (escapeHatch.test(source)) {
    return [];
  }
  return prohibited.flatMap(({ rule, pattern, detail }) =>
    pattern.test(source) ? [{ file, rule, detail }] : [],
  );
}

/**
 * Acceptance means a real installed adapter observed through its public
 * protocol. Static module replacement and unit-test fakes only prove our
 * imitation of that boundary. A rare exception must carry a specific,
 * human-readable `boundary-simulator-escape-hatch:` rationale.
 */
export function scanAcceptanceBoundaryStyle(
  roots: readonly string[] = [resolve(root, "packages"), resolve(root, "apps")],
): AcceptanceBoundaryViolation[] {
  return roots.flatMap((directory) =>
    filesBelow(directory).flatMap((file) =>
      inspectAcceptanceBoundarySource(
        readFileSync(file, "utf8"),
        file.startsWith(root) ? file.slice(root.length + 1) : file,
      ),
    ),
  );
}
