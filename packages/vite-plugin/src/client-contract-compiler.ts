import { readFile } from "node:fs/promises";
import { parse, traverse, transformFromAstSync, types as t } from "@babel/core";
import type { Plugin } from "vite";

const CLIENT_QUERY_NAME = "sweatpants-client-contract";
const CLIENT_QUERY = `?${CLIENT_QUERY_NAME}`;

function clientContractSource(source: string, exports: readonly string[]): string {
  return exports.length === 0
    ? `${source}${CLIENT_QUERY}`
    : `${source}${CLIENT_QUERY}=${encodeURIComponent(exports.join(","))}`;
}

function parseClientContractId(
  id: string,
): { readonly plain: string; readonly exports: readonly string[] } | undefined {
  const marker = `${CLIENT_QUERY}=`;
  const markerIndex = id.indexOf(marker);
  if (markerIndex !== -1) {
    const value = id.slice(markerIndex + marker.length).split("&", 1)[0] ?? "";
    return {
      plain: id.slice(0, markerIndex),
      exports: decodeURIComponent(value).split(",").filter(Boolean),
    };
  }
  return id.endsWith(CLIENT_QUERY)
    ? { plain: id.slice(0, -CLIENT_QUERY.length), exports: [] }
    : undefined;
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

export type ClientContractDiagnosticCode =
  | "client_contract_not_static"
  | "client_contract_server_reachable";

export class ClientContractCompilerError extends Error {
  constructor(
    readonly code: ClientContractDiagnosticCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientContractCompilerError";
  }
}

export interface ClientContractAnalysis {
  readonly toolBindings: readonly string[];
  readonly makePluginCalls: number;
}

function parseSource(source: string, filename: string) {
  const ast = parse(source, {
    filename,
    parserOpts: { plugins: ["typescript", "jsx"] },
    sourceType: "module",
  });
  if (!ast) {
    throw new ClientContractCompilerError(
      "client_contract_not_static",
      `Unable to parse client plugin source ${filename}`,
    );
  }
  return ast;
}

function importedMakePluginNames(ast: ReturnType<typeof parseSource>): Set<string> {
  const names = new Set<string>();
  for (const statement of ast.program.body) {
    if (!t.isImportDeclaration(statement)) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (!t.isImportSpecifier(specifier)) {
        continue;
      }
      const imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
      if (imported === "makePlugin") {
        names.add(specifier.local.name);
      }
    }
  }
  return names;
}

/** Analyze only static imported identifiers passed to framework makePlugin. */
export function analyzeClientContractSource(
  source: string,
  filename = "<client-plugin>",
): ClientContractAnalysis {
  const ast = parseSource(source, filename);
  const makePluginNames = importedMakePluginNames(ast);
  const toolBindings: string[] = [];
  let makePluginCalls = 0;
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee) || !makePluginNames.has(path.node.callee.name)) {
        return;
      }
      makePluginCalls += 1;
      const argument = path.node.arguments[0];
      if (!argument || !t.isIdentifier(argument)) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: makePlugin input must be a statically imported tool identifier; ` +
            `dynamic, conditional, and computed expressions are unsupported`,
        );
      }
      const binding = path.scope.getBinding(argument.name);
      if (
        !binding ||
        (!binding.path.isImportSpecifier() && !binding.path.isImportDefaultSpecifier())
      ) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: makePlugin(${argument.name}) must reference a statically imported tool`,
        );
      }
      toolBindings.push(argument.name);
    },
  });
  return { toolBindings, makePluginCalls };
}

function contractTerminal(): t.FunctionExpression {
  return t.functionExpression(
    null,
    [],
    t.blockStatement([t.returnStatement(t.nullLiteral())]),
    true,
  );
}

/**
 * Generate a client-only variant of a tool module. The fluent builder still
 * creates the authored schemas and artifacts, while ordinary execution and
 * durable effect implementations are replaced before the module reaches a
 * frontend bundle.
 */
export function generateClientContractModule(
  source: string,
  filename = "<tool-module>",
  requestedExports: readonly string[] = [],
): string {
  const ast = parseSource(source, filename);
  let executeTerminals = 0;
  const executionHelpers = new Set<string>();
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) {
        return;
      }
      if (callee.property.name === "effects") {
        const effects = path.node.arguments[0];
        if (t.isIdentifier(effects)) {
          executionHelpers.add(effects.name);
        }
        path.node.arguments = [t.objectExpression([])];
        return;
      }
      if (callee.property.name !== "execute") {
        return;
      }
      if (path.node.arguments.length !== 1) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: executable builder terminal must have exactly one authored implementation`,
        );
      }
      const implementation = path.node.arguments[0];
      if (t.isIdentifier(implementation)) {
        executionHelpers.add(implementation.name);
      }
      path.node.arguments = [contractTerminal()];
      executeTerminals += 1;
    },
  });
  if (executeTerminals === 0) {
    const requested = new Set(requestedExports);
    let rewritten = 0;
    ast.program.body = ast.program.body.flatMap((statement): t.Statement[] => {
      if (t.isExportNamedDeclaration(statement) && statement.source) {
        const specifiers = statement.specifiers.filter(
          (specifier): specifier is t.ExportSpecifier =>
            t.isExportSpecifier(specifier) && requested.has(exportedName(specifier.exported)),
        );
        if (specifiers.length === 0) {
          return [];
        }
        const imported = specifiers.map((specifier) => exportedName(specifier.local));
        statement.specifiers = specifiers;
        statement.source.value = clientContractSource(statement.source.value, imported);
        rewritten += 1;
        return [statement];
      }
      if (t.isExportAllDeclaration(statement) && requested.size > 0) {
        statement.source.value = clientContractSource(statement.source.value, [...requested]);
        rewritten += 1;
        return [statement];
      }
      return [];
    });
    if (rewritten === 0) {
      throw new ClientContractCompilerError(
        "client_contract_not_static",
        `${filename}: no supported tool terminal or explicit re-export was found`,
      );
    }
    const result = transformFromAstSync(ast, source, {
      filename,
      presets: [["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
      sourceType: "module",
    });
    if (!result?.code) {
      throw new ClientContractCompilerError(
        "client_contract_server_reachable",
        `${filename}: client contract barrel generation produced no module`,
      );
    }
    return result.code;
  }
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
      // A named implementation can also serve server-side callers. Its export
      // must not retain execution in the client variant requested by makePlugin.
      // Repeat after removing a body whose type annotation references effects.
      for (const name of [...executionHelpers].reverse()) {
        path.scope.crawl();
        const binding = path.scope.getBinding(name);
        if (!binding || requestedExports.includes(name)) {
          continue;
        }
        const references = binding.referencePaths.filter(
          (reference) => !reference.isExportNamedDeclaration(),
        );
        if (references.length === 0 && binding.path.isFunctionDeclaration()) {
          if (binding.path.parentPath.isExportNamedDeclaration()) {
            binding.path.parentPath.remove();
          } else {
            binding.path.remove();
          }
        } else if (references.length === 0 && binding.path.isVariableDeclarator()) {
          binding.path.remove();
        }
      }
      path.scope.crawl();
    },
  });
  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.specifiers.length === 0) {
        throw new ClientContractCompilerError(
          "client_contract_server_reachable",
          `${filename}: side-effect import "${path.node.source.value}" is reachable while extracting the client contract`,
        );
      }
      path.node.specifiers = path.node.specifiers.filter((specifier) => {
        const binding = path.scope.getBinding(specifier.local.name);
        return binding === undefined || binding.referencePaths.length > 0;
      });
      if (path.node.specifiers.length === 0) {
        path.remove();
      }
    },
  });
  const result = transformFromAstSync(ast, source, {
    filename,
    presets: [["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
    sourceType: "module",
  });
  if (!result?.code) {
    throw new ClientContractCompilerError(
      "client_contract_server_reachable",
      `${filename}: client contract generation produced no module`,
    );
  }
  return result.code;
}

function rewriteStaticToolImports(source: string, filename: string): string | null {
  const ast = parseSource(source, filename);
  const makePluginNames = importedMakePluginNames(ast);
  if (makePluginNames.size === 0) {
    return null;
  }
  const importedTools = new Set<string>();
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee) || !makePluginNames.has(path.node.callee.name)) {
        return;
      }
      const argument = path.node.arguments[0];
      if (!argument || !t.isIdentifier(argument)) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: makePlugin input is not statically identifiable`,
        );
      }
      const binding = path.scope.getBinding(argument.name);
      if (
        !binding ||
        (!binding.path.isImportSpecifier() && !binding.path.isImportDefaultSpecifier())
      ) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: makePlugin input must be a statically imported identifier`,
        );
      }
      importedTools.add(argument.name);
    },
  });
  if (importedTools.size === 0) {
    return null;
  }
  for (const statement of ast.program.body) {
    if (!t.isImportDeclaration(statement)) {
      continue;
    }
    const requested = statement.specifiers.flatMap((specifier) => {
      if (!importedTools.has(specifier.local.name)) {
        return [];
      }
      if (t.isImportDefaultSpecifier(specifier)) {
        return ["default"];
      }
      if (t.isImportSpecifier(specifier)) {
        return [
          t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value,
        ];
      }
      return [];
    });
    if (requested.length > 0) {
      statement.source.value = clientContractSource(statement.source.value, requested);
    }
  }
  const result = transformFromAstSync(ast, source, {
    filename,
    presets: [["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
    sourceType: "module",
  });
  return result?.code ?? source;
}

/** Vite adapter around the reusable compiler functions above. */
export function clientContractPlugin(): Plugin {
  return {
    name: "@sweatpants/vite-plugin:client-contract",
    enforce: "pre",
    async resolveId(source, importer) {
      const contract = parseClientContractId(source);
      if (!contract) {
        return null;
      }
      const resolved = await this.resolve(contract.plain, importer, { skipSelf: true });
      return resolved ? clientContractSource(resolved.id, contract.exports) : null;
    },
    async load(id) {
      const contract = parseClientContractId(id);
      if (!contract) {
        return null;
      }
      return generateClientContractModule(
        await readFile(contract.plain, "utf8"),
        contract.plain,
        contract.exports,
      );
    },
    transform(source, id) {
      if (
        parseClientContractId(id) ||
        !/import\s*\{[^}]*\bmakePlugin\b[^}]*\}\s*from/u.test(source)
      ) {
        return null;
      }
      return rewriteStaticToolImports(source, id);
    },
  };
}

export { CLIENT_QUERY as CLIENT_CONTRACT_QUERY };
