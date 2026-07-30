import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

export type ValidationTrust = "B" | "I" | "B+GAP" | "D";
export type ValidationSeam = "FI" | "AD" | "UA";
export type ValidationDisposition =
  | "parse"
  | "safe-parse"
  | "assert"
  | "verify"
  | "standard-schema-callback"
  | "delete";

export interface ValidationBoundaryInventoryEntry {
  readonly id: string;
  readonly file: string;
  readonly symbol: string;
  readonly declarationKind: "function" | "method" | "callback" | "property";
  readonly callers: readonly string[];
  readonly trust: ValidationTrust;
  readonly seams: readonly ValidationSeam[];
  readonly structuralAuthority: "zod" | "standard-schema" | "none";
  readonly disposition: ValidationDisposition;
  readonly replacement?: string;
  readonly evidence: readonly string[];
}

export interface ValidationBoundaryInventory {
  readonly format: "sweatpants.validation-boundary-inventory.v1";
  readonly entries: readonly ValidationBoundaryInventoryEntry[];
}

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const inventoryPath = resolve(root, "docs/architecture/validation-boundary-inventory.json");

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (
        entry !== "dist" &&
        entry !== "node_modules" &&
        entry !== "__tests__" &&
        entry !== "testing"
      ) {
        result.push(...sourceFiles(path));
      }
    } else if (
      (path.endsWith(".ts") || path.endsWith(".tsx")) &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".spec.ts")
    ) {
      result.push(path);
    }
  }
  return result.sort();
}

function nameOf(node: ts.Node): string | undefined {
  if (!("name" in node)) return undefined;
  const name = (node as ts.NamedDeclaration).name;
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.getText().replace(/^#/, "");
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function declarationKind(
  node: ts.Node,
  name: string,
): ValidationBoundaryInventoryEntry["declarationKind"] {
  if (name === "validate") return "callback";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  return "function";
}

export interface ScannedDeclaration {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly declarationKind: ValidationBoundaryInventoryEntry["declarationKind"];
}

export interface UncheckedBoundaryCast {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
}

function unwrapBoundaryExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    return unwrapBoundaryExpression(expression.expression);
  }
  return expression;
}

function isExternalDecodeCall(expression: ts.Expression): boolean {
  const unwrapped = unwrapBoundaryExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return false;
  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    const method = unwrapped.expression.name.text;
    if (method === "json") return true;
    if (method === "parse" && unwrapped.expression.expression.getText() === "JSON") {
      const argument = unwrapped.arguments[0];
      // JSON round-tripping an already typed in-memory value is cloning, not
      // an external decode boundary.
      return !(
        argument &&
        ts.isCallExpression(argument) &&
        ts.isPropertyAccessExpression(argument.expression) &&
        argument.expression.expression.getText() === "JSON" &&
        argument.expression.name.text === "stringify"
      );
    }
  }
  return false;
}

/** Finds direct decode-to-domain assertions. `unknown` containment is allowed. */
function auditedBoundaryFiles(): string[] {
  const packages = [
    "a2a",
    "agent-host",
    "cli",
    "durable-chat-runtime",
    "durable-execution",
    "tool-runtime-agentcore",
    "tool-session",
    "workspace-runtime",
  ];
  return packages
    .flatMap((name) => sourceFiles(resolve(root, "packages", name, "src")))
    .filter((file) => !file.endsWith("/testing.ts"));
}

export function scanUncheckedBoundaryCasts(
  files: readonly string[] = auditedBoundaryFiles(),
): UncheckedBoundaryCast[] {
  const violations: UncheckedBoundaryCast[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) && isExternalDecodeCall(node.expression)) {
        const assertedType = node.type.getText(sourceFile);
        if (assertedType !== "unknown") {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: file.startsWith(root) ? file.slice(root.length + 1) : file,
            line: line + 1,
            expression: node.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

export function scanValidationDeclarations(): ScannedDeclaration[] {
  const declarations: ScannedDeclaration[] = [];
  for (const file of sourceFiles(resolve(root, "packages"))) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      let symbol: string | undefined;
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyAssignment(node)
      ) {
        symbol = nameOf(node);
      }
      if (symbol === "validate" || symbol?.startsWith("validate")) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        declarations.push({
          file: file.slice(root.length + 1),
          line: line + 1,
          symbol,
          declarationKind: declarationKind(node, symbol),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return declarations.sort((left, right) =>
    `${left.file}:${left.line}:${left.symbol}`.localeCompare(
      `${right.file}:${right.line}:${right.symbol}`,
    ),
  );
}

function allReferences(
  symbol: string,
  files: readonly string[],
  declaration: ScannedDeclaration,
): string[] {
  const references: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (
        !new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(
          lines[index]!,
        )
      ) {
        continue;
      }
      const relative = file.slice(root.length + 1);
      if (relative === declaration.file && index + 1 === declaration.line) continue;
      references.push(`${relative}:${index + 1}`);
    }
  }
  return references;
}

function defaultClassification(
  declaration: ScannedDeclaration,
): Pick<
  ValidationBoundaryInventoryEntry,
  "trust" | "seams" | "structuralAuthority" | "disposition"
> {
  if (declaration.symbol === "validate" || declaration.symbol === "validateStandardSchema") {
    return {
      trust: "B",
      seams: ["UA", "AD"],
      structuralAuthority: "standard-schema",
      disposition: "standard-schema-callback",
    };
  }
  const external =
    /(?:protocol|request|response|manifest|record|page|header|url|pin|payload|release|catalog|resume|tool-parameter)/i.test(
      declaration.symbol,
    ) ||
    /(?:protocol|request-parser|fetch-manifest|remote-development|foreign|discovery|connector|durable-protocol|schema-registry)/.test(
      declaration.file,
    );
  return {
    trust: external ? "B+GAP" : "I",
    seams: external ? ["AD"] : ["FI"],
    structuralAuthority: external ? "zod" : "none",
    disposition: external ? "parse" : "assert",
  };
}

export function createInitialInventory(): ValidationBoundaryInventory {
  const files = sourceFiles(resolve(root, "packages"));
  const entries = scanValidationDeclarations().map((declaration, index) => {
    const classification = defaultClassification(declaration);
    const callers = allReferences(declaration.symbol, files, declaration);
    return {
      id: `VAL-${String(index + 1).padStart(3, "0")}`,
      file: declaration.file,
      symbol: declaration.symbol,
      declarationKind: declaration.declarationKind,
      callers,
      ...classification,
      evidence: [`${declaration.file}:${declaration.line}`],
    } satisfies ValidationBoundaryInventoryEntry;
  });
  return { format: "sweatpants.validation-boundary-inventory.v1", entries };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates the committed inventory before any declaration comparison runs. */
export function assertInventory(value: unknown): asserts value is ValidationBoundaryInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Validation inventory must be an object");
  }
  const inventory = value as Record<string, unknown>;
  if (inventory["format"] !== "sweatpants.validation-boundary-inventory.v1") {
    throw new Error("Validation inventory has an unsupported format");
  }
  if (!Array.isArray(inventory["entries"])) {
    throw new Error("Validation inventory entries must be an array");
  }
  const ids = new Set<string>();
  for (const candidate of inventory["entries"]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Validation inventory entry must be an object");
    }
    const entry = candidate as Record<string, unknown>;
    for (const field of [
      "id",
      "file",
      "symbol",
      "declarationKind",
      "structuralAuthority",
      "disposition",
    ]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`Validation inventory entry is missing ${field}`);
      }
    }
    if (typeof entry["id"] === "string") {
      if (ids.has(entry["id"])) throw new Error(`Duplicate validation inventory id ${entry["id"]}`);
      ids.add(entry["id"]);
    }
    if (!isStringArray(entry["callers"]) || !isStringArray(entry["evidence"])) {
      throw new Error("Validation inventory callers and evidence must be string arrays");
    }
    if (entry["trust"] !== "D" && entry["callers"].length === 0) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has no callers`);
    }
    if (entry["evidence"].length === 0) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has no evidence`);
    }
    if (!isStringArray(entry["seams"]) || entry["seams"].length === 0) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has no seam`);
    }
    if (!["B", "I", "B+GAP", "D"].includes(String(entry["trust"]))) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has invalid trust`);
    }
    if (
      !(entry["seams"] as readonly unknown[]).every((seam) =>
        ["FI", "AD", "UA"].includes(String(seam)),
      )
    ) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has invalid seam`);
    }
    if (!["zod", "standard-schema", "none"].includes(String(entry["structuralAuthority"]))) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has invalid authority`);
    }
    if (
      !["parse", "safe-parse", "assert", "verify", "standard-schema-callback", "delete"].includes(
        String(entry["disposition"]),
      )
    ) {
      throw new Error(`Validation inventory entry ${String(entry["id"])} has invalid disposition`);
    }
    if (entry["disposition"] === "delete" && typeof entry["replacement"] !== "string") {
      throw new Error(
        `Deleted validation inventory entry ${String(entry["id"])} needs a disposition record`,
      );
    }
  }
}

function evidencePath(locator: string): string {
  const withoutIdentifier = locator.split("#", 1)[0]!;
  return withoutIdentifier.replace(/:\d+$/u, "");
}

/** Resolves final replacement symbols and source/test evidence against the tree. */
export function assertInventoryEvidence(inventory: ValidationBoundaryInventory): void {
  const production = sourceFiles(resolve(root, "packages")).map((file) =>
    readFileSync(file, "utf8"),
  );
  for (const entry of inventory.entries) {
    if (entry.callers.some((caller) => caller === "pre-cleanup production call graph")) {
      throw new Error(`Validation inventory entry ${entry.id} has placeholder callers`);
    }
    if (entry.disposition === "delete") {
      const replacement = entry.replacement!;
      const pattern = new RegExp(
        `\\b${replacement.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`,
        "u",
      );
      if (!production.some((source) => pattern.test(source))) {
        throw new Error(`Validation inventory replacement ${replacement} does not resolve`);
      }
    }
    let hasTestEvidence = false;
    for (const locator of entry.evidence) {
      const relative = evidencePath(locator);
      if (!existsSync(resolve(root, relative))) {
        throw new Error(`Validation inventory evidence does not resolve: ${locator}`);
      }
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative)) hasTestEvidence = true;
    }
    if (!hasTestEvidence) {
      throw new Error(`Validation inventory entry ${entry.id} has no test evidence`);
    }
  }
}

export function readInventory(path = inventoryPath): ValidationBoundaryInventory {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertInventory(value);
  return value;
}

export function writeInitialInventory(path = inventoryPath): void {
  const scanned = createInitialInventory().entries;
  const historical = existsSync(path)
    ? readInventory(path).entries.filter((entry) => entry.disposition === "delete")
    : [];
  const entries = scanned.map((entry, index) => ({
    ...entry,
    id: `VAL-${String(historical.length + index + 1).padStart(3, "0")}`,
  }));
  const inventory: ValidationBoundaryInventory = {
    format: "sweatpants.validation-boundary-inventory.v1",
    entries: [...historical, ...entries],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("validation-boundary-inventory.ts")) {
  writeInitialInventory();
  console.log(`Wrote ${inventoryPath}`);
}
