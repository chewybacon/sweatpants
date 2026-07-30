import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AuthoredSchemaRederivation {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist" && entry !== "__tests__") {
        files.push(...sourceFiles(path));
      }
    } else if (
      /\.[cm]?[jt]sx?$/u.test(entry) &&
      !/(?:\.test|\.spec|\.acceptance\.test)\.[cm]?[jt]sx?$/u.test(entry)
    ) {
      files.push(path);
    }
  }
  return files;
}

function isProjectionCall(node: ts.CallExpression): boolean {
  const callee = node.expression.getText();
  return callee === "toToolParameterJsonSchema" || callee === "z.toJSONSchema";
}

function isInsideAuthoringOwner(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name &&
      ["defineTool", "createTool", "buildToolSchemaArtifacts"].includes(current.name.text)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * An authored tool's `.parameters` validator and portable artifact are created
 * together. Re-projecting `.parameters` downstream can only produce a second
 * answer to an already-settled contract. Runtime-authored `.inputSchema` and
 * `.schema` values are intentionally not covered: their call site is the
 * authoring ingress and must perform the projection.
 */
export function scanAuthoredSchemaRederivation(
  files: readonly string[] = [resolve(root, "packages"), resolve(root, "apps")].flatMap(
    sourceFiles,
  ),
): AuthoredSchemaRederivation[] {
  const violations: AuthoredSchemaRederivation[] = [];
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
      if (ts.isCallExpression(node) && isProjectionCall(node)) {
        const argument = node.arguments[0];
        if (
          argument &&
          ts.isPropertyAccessExpression(argument) &&
          argument.name.text === "parameters" &&
          !isInsideAuthoringOwner(node)
        ) {
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
