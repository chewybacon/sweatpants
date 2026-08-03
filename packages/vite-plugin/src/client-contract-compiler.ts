import { readFile } from "node:fs/promises";
import { parse, traverse, transformFromAstSync, types as t } from "@babel/core";
import type { Plugin } from "vite";

const CLIENT_QUERY = "?sweatpants-client-contract";

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
    presets: ["@babel/preset-typescript"],
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
 * creates the authored schemas and artifacts, while the executable terminal is
 * replaced before the module reaches a frontend bundle.
 */
export function generateClientContractModule(source: string, filename = "<tool-module>"): string {
  const ast = parseSource(source, filename);
  let executeTerminals = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        !t.isMemberExpression(callee) ||
        callee.computed ||
        !t.isIdentifier(callee.property, { name: "execute" })
      ) {
        return;
      }
      if (path.node.arguments.length !== 1) {
        throw new ClientContractCompilerError(
          "client_contract_not_static",
          `${filename}: executable builder terminal must have exactly one authored implementation`,
        );
      }
      path.node.arguments = [contractTerminal()];
      executeTerminals += 1;
    },
  });
  if (executeTerminals === 0) {
    throw new ClientContractCompilerError(
      "client_contract_not_static",
      `${filename}: no supported createTool/createDurableTool execute terminal was found`,
    );
  }
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
    presets: ["@babel/preset-typescript"],
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
    const hasTool = statement.specifiers.some((specifier) =>
      t.isImportSpecifier(specifier) || t.isImportDefaultSpecifier(specifier)
        ? importedTools.has(specifier.local.name)
        : false,
    );
    if (hasTool) {
      statement.source.value = `${statement.source.value}${CLIENT_QUERY}`;
    }
  }
  const result = transformFromAstSync(ast, source, {
    filename,
    presets: ["@babel/preset-typescript"],
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
      if (!source.endsWith(CLIENT_QUERY)) {
        return null;
      }
      const plain = source.slice(0, -CLIENT_QUERY.length);
      const resolved = await this.resolve(plain, importer, { skipSelf: true });
      return resolved ? `${resolved.id}${CLIENT_QUERY}` : null;
    },
    async load(id) {
      if (!id.endsWith(CLIENT_QUERY)) {
        return null;
      }
      const plain = id.slice(0, -CLIENT_QUERY.length);
      return generateClientContractModule(await readFile(plain, "utf8"), plain);
    },
    transform(source, id) {
      if (id.includes(CLIENT_QUERY)) {
        return null;
      }
      return rewriteStaticToolImports(source, id);
    },
  };
}

export { CLIENT_QUERY as CLIENT_CONTRACT_QUERY };
