import { retainReachableFunctions } from "./reachable.js";
import type * as Babel from "@babel/core";
import { createRequire } from "node:module";
import { lowerWorkflow } from "./lower.js";
import { createSourceProgram } from "./source-program.js";
import type { SchemeProgram } from "./scheme-ir.js";

import {
  createWorkflowCompiler,
  type CompileRequest,
  type CompiledWorkflow,
  type Diagnostic,
  type SourcePosition,
  type WorkflowCompiler,
} from "@sweatpants/flowmode-runtime";
import type { Operation } from "effection";
import type { TypeScriptWorkflowTarget, WorkflowEntry } from "./types.js";
const babel = createRequire(import.meta.url)("@babel/core") as typeof Babel;

function compileErrorPosition(error: unknown, sourceId: string): SourcePosition {
  if (error && typeof error === "object") {
    if ("position" in error && error.position && typeof error.position === "object") {
      const p = error.position;
      if (
        "sourceId" in p &&
        typeof p.sourceId === "string" &&
        "line" in p &&
        typeof p.line === "number" &&
        "column" in p &&
        typeof p.column === "number"
      ) {
        return { sourceId: p.sourceId, line: p.line, column: p.column };
      }
    }
    if ("loc" in error && error.loc && typeof error.loc === "object") {
      const p = error.loc;
      if (
        "line" in p &&
        typeof p.line === "number" &&
        "column" in p &&
        typeof p.column === "number"
      ) {
        return { sourceId, line: p.line, column: p.column + 1 };
      }
    }
  }
  return { sourceId, line: 1, column: 1 };
}
/** Shared build transform: no module evaluation or bundler state. */
export interface PreparedWorkflow {
  request: CompileRequest;
  program: SchemeProgram;
  definitions: WorkflowEntry[];
  diagnostics: Diagnostic[];
  dependencies: string[];
  resolutions: { importer: string; specifier: string; resolved: string }[];
}
export function prepareWorkflow(request: CompileRequest): PreparedWorkflow {
  const {
    source: { id },
    exports: declaredExports,
    bindings,
  } = request;
  const sources = createSourceProgram(request.source);
  const ast = sources.ast;
  const t = babel.types;
  let builderName: string | undefined;
  let schemaName: string | undefined;
  const definitions: (WorkflowEntry & { inline?: Babel.types.FunctionExpression })[] = [];
  const removed: Babel.types.Node[] = [];
  for (const node of ast!.program.body) {
    if (t.isImportDeclaration(node) && node.source.value === "@sweatpants/agent-sdk/legacy") {
      if (
        node.specifiers.length !== 1 ||
        !t.isImportSpecifier(node.specifiers[0]) ||
        !t.isIdentifier(node.specifiers[0].imported, { name: "createDurableTool" })
      ) {
        throw Error(`${id}: expected createDurableTool import`);
      }
      builderName = node.specifiers[0].local.name;
      removed.push(node);
    } else if (t.isImportDeclaration(node) && node.source.value === "zod") {
      if (
        node.specifiers.length !== 1 ||
        !t.isImportSpecifier(node.specifiers[0]) ||
        !t.isIdentifier(node.specifiers[0].imported, { name: "z" })
      ) {
        throw Error(`${id}: expected z import`);
      }
      schemaName = node.specifiers[0].local.name;
      removed.push(node);
    } else if (
      (t.isImportDeclaration(node) && node.importKind === "type") ||
      t.isTSInterfaceDeclaration(node) ||
      t.isTSTypeAliasDeclaration(node)
    ) {
      removed.push(node);
    } else if (t.isExportNamedDeclaration(node)) {
      const declaration = node.declaration;
      if (!t.isVariableDeclaration(declaration) || declaration.kind !== "const") {
        throw Error(`${id}: export a const compiled definition`);
      }
      for (const binding of declaration.declarations) {
        const init = binding.init;
        if (
          !t.isIdentifier(binding.id) ||
          !t.isCallExpression(init) ||
          !t.isMemberExpression(init.callee) ||
          init.callee.computed ||
          !t.isIdentifier(init.callee.property, { name: "execute" }) ||
          init.arguments.length !== 1 ||
          !(t.isIdentifier(init.arguments[0]) || t.isFunctionExpression(init.arguments[0]))
        ) {
          throw Error(`${id}: expected createDurableTool(...).execute(namedGenerator)`);
        }
        validateBuilder(init.callee.object);
        const execute = init.arguments[0];
        const name = binding.id.name;
        const declared = declaredExports.find((e) => e.name === name);
        const entry = t.isIdentifier(execute) ? execute.name : declared?.entry;
        if (!entry) {
          throw Error(`${id}: missing export contract for ${name}`);
        }
        definitions.push({
          name: binding.id.name,
          entry,
          inline: t.isFunctionExpression(execute) ? execute : undefined,
        });
      }
      removed.push(node);
    }
  }
  if (!definitions.length) {
    throw Error(`${id}: no compiled workflow definitions`);
  }
  function staticValue(node: Babel.types.Node | null | undefined): void {
    if (
      t.isStringLiteral(node) ||
      t.isNumericLiteral(node) ||
      t.isBooleanLiteral(node) ||
      t.isNullLiteral(node)
    ) {
      return;
    }
    if (t.isArrayExpression(node)) {
      for (const item of node.elements) {
        staticValue(item);
      }
      return;
    }
    if (t.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (!t.isObjectProperty(property) || property.computed || property.shorthand) {
          throw Error("Dynamic workflow declaration");
        }
        staticValue(property.value);
      }
      return;
    }
    if (
      t.isCallExpression(node) &&
      t.isMemberExpression(node.callee) &&
      !node.callee.computed &&
      t.isIdentifier(node.callee.property) &&
      t.isIdentifier(node.callee.object, { name: schemaName }) &&
      ["object", "string", "boolean", "number", "null", "enum", "array", "literal"].includes(
        node.callee.property.name,
      )
    ) {
      for (const argument of node.arguments) {
        staticValue(argument);
      }
      return;
    }
    throw Error("Dynamic workflow declaration; supply a statically supported builder");
  }
  function validateBuilder(node: Babel.types.Node): void {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: builderName })) {
      if (node.arguments.length !== 2 || !t.isStringLiteral(node.arguments[0])) {
        throw Error("Workflow tool requires static name and version");
      }
      staticValue(node.arguments[1]);
      return;
    }
    if (
      !t.isCallExpression(node) ||
      !t.isMemberExpression(node.callee) ||
      node.callee.computed ||
      !t.isIdentifier(node.callee.property) ||
      !["description", "parameters", "output", "elicits"].includes(node.callee.property.name) ||
      node.arguments.length !== 1
    ) {
      throw Error("Unsupported workflow builder declaration");
    }
    staticValue(node.arguments[0]);
    validateBuilder(node.callee.object);
  }
  ast.program.body = ast.program.body.filter((node) => !removed.includes(node));
  for (const definition of definitions) {
    const fn =
      definition.inline ??
      ast.program.body.find(
        (node): node is Babel.types.FunctionDeclaration =>
          t.isFunctionDeclaration(node) && node.id?.name === definition.entry,
      );
    if (!fn) {
      throw Error(`${id}: unknown workflow entry ${definition.entry}`);
    }
    if (
      fn.params.length !== 2 ||
      !t.isIdentifier(fn.params[0], { name: "input" }) ||
      !t.isIdentifier(fn.params[1], { name: "ctx" })
    ) {
      throw Error("Workflow execute requires (input, ctx)");
    }
    // Only exported entry functions use the private ctx/input backend convention.
    fn.params = [fn.params[1], fn.params[0]];
    if (definition.inline) {
      const declaration = t.functionDeclaration(
        t.identifier(definition.entry),
        fn.params,
        fn.body,
        fn.generator,
        fn.async,
      );
      declaration.loc = fn.loc;
      ast.program.body.push(declaration);
    }
  }
  const program = lowerWorkflow(ast, {
    sourceId: id,
    types: sources.types,
    definitions,
    entryPoint: null,
    entryInput: true,
    allowEnsure: true,
    allowFinally: true,
  });
  retainReachableFunctions(
    program,
    definitions.map((d) => d.entry),
  );
  for (const site of Object.values(program.debug.sites)) {
    if (site.operation === "scoped") {
      throw Error(`Undeclared workflow exchange: ${JSON.stringify(["effect", null, null])}`);
    }
    const bindingId =
      site.operation === "elicit"
        ? JSON.stringify(["elicit", site.key])
        : JSON.stringify(["effect", site.name, site.version]);
    if (!bindings.some((binding) => binding.kind === "host" && binding.contract.id === bindingId)) {
      throw Object.assign(Error(`Undeclared workflow exchange: ${bindingId}`), {
        position: { sourceId: site.sourceId ?? id, line: site.line, column: site.column + 1 },
      });
    }
  }
  for (const { name, entry } of definitions) {
    if (!declaredExports.some((e) => e.name === name && e.entry === entry)) {
      throw Error(`${id}: missing export contract for ${name}`);
    }
  }
  return {
    request,
    program,
    definitions,
    diagnostics: sources.diagnostics(),
    dependencies: sources.dependencies,
    resolutions: sources.resolutions,
  };
}

export function emitPreparedWorkflow(
  prepared: PreparedWorkflow,
  target: TypeScriptWorkflowTarget,
): CompiledWorkflow {
  const { request, program, definitions } = prepared;
  const emitted = target.emit(program, definitions);
  if (
    !definitions.some((d) => d.entry === request.entry) ||
    request.exports.some((e) => !definitions.some((d) => d.name === e.name && d.entry === e.entry))
  ) {
    throw Error("Unknown declared workflow export");
  }
  return {
    entry: request.entry,
    implementation: { format: target.definitionFormat, payload: emitted.payload },
    source: request.source,
    exports: request.exports,
    imports: request.bindings,
    debug: emitted.debug,
  };
}

/**
 * Target-local emission after shared SDK extraction; no new persisted IR or runtime protocol.
 */
export function createTypeScriptWorkflowCompiler(
  target: TypeScriptWorkflowTarget,
): WorkflowCompiler {
  return createWorkflowCompiler({
    driver: {
      sourceLanguage: "typescript",
      definitionFormat: target.definitionFormat,
      *compile({ source, entry, exports, bindings }) {
        try {
          if (source.language !== "typescript") {
            throw Error("Workflow compiler requires TypeScript source");
          }
          const prepared = prepareWorkflow({ source, entry, exports, bindings });
          const module = emitPreparedWorkflow(prepared, target);
          const diagnostics = prepared.diagnostics;
          if (diagnostics.some((d) => d.severity === "error")) {
            return { ok: false, diagnostics };
          }
          return { ok: true, module, diagnostics };
        } catch (error) {
          return {
            ok: false,
            diagnostics: [
              {
                severity: "error",
                code: "typescript_workflow_compile",
                message: error instanceof Error ? error.message : String(error),
                position: compileErrorPosition(error, source.id),
              },
            ],
          };
        }
      },
    },
  });
}

/** Bundler representation is separate from the portable compiler output.
 */
export function* compileWorkflowModule(
  source: string,
  id: string,
  declarations: Omit<CompileRequest, "source">,
  compiler: WorkflowCompiler,
): Operation<string> {
  const result = yield* compiler.compile({
    source: { language: "typescript", text: source, id },
    ...declarations,
  });
  if (!result.ok) {
    throw Error(result.diagnostics.map((d) => d.message).join("\n"));
  }
  return result.module.exports
    .map((exported) => `export const ${exported.name} = ${JSON.stringify(result.module)};`)
    .join("\n");
}
