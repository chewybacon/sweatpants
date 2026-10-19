import { basename, resolve } from "node:path";
import ts from "typescript";
import { call, run } from "effection";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { HOOT_DEFINITION_FORMAT } from "../hoot-composition/linker.mts";
import { emitWorkflowScheme } from "../scheme-compiler/emit.mjs";
const babel = createRequire(new URL("../../../packages/vite-plugin/package.json", import.meta.url))(
  "@babel/core",
);

/** Shared build transform: no module evaluation or bundler state. */
function compileDefinitions(source, id, declaredExports, bindings) {
  const ast = babel.parseSync(source, {
    filename: id,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  const t = babel.types;
  let builderName;
  let schemaName;
  const definitions = [];
  const removed = [];
  for (const node of ast.program.body) {
    if (
      t.isImportDeclaration(node) &&
      ["@sweatpants/agent-sdk", "@sweatpants/agent-sdk/tool"].includes(node.source.value)
    ) {
      if (
        node.specifiers.length !== 1 ||
        !t.isImportSpecifier(node.specifiers[0]) ||
        node.specifiers[0].imported.name !== "createDurableTool"
      ) {
        throw Error(`${id}: expected createDurableTool import`);
      }
      builderName = node.specifiers[0].local.name;
      removed.push(node);
    } else if (t.isImportDeclaration(node) && node.source.value === "zod") {
      if (
        node.specifiers.length !== 1 ||
        !t.isImportSpecifier(node.specifiers[0]) ||
        node.specifiers[0].imported.name !== "z"
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
          !t.isIdentifier(init.arguments[0])
        ) {
          throw Error(`${id}: expected createDurableTool(...).execute(namedGenerator)`);
        }
        validateBuilder(init.callee.object);
        definitions.push({ name: binding.id.name, entry: init.arguments[0].name });
      }
      removed.push(node);
    }
  }
  if (!definitions.length) {
    throw Error(`${id}: no compiled workflow definitions`);
  }
  function staticValue(node) {
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
  function validateBuilder(node) {
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
      !["description", "parameters", "output", "elicits"].includes(node.callee.property.name) ||
      node.arguments.length !== 1
    ) {
      throw Error("Unsupported workflow builder declaration");
    }
    staticValue(node.arguments[0]);
    validateBuilder(node.callee.object);
  }
  // Keep source line positions; only the target ABI reorders input/context parameters.
  const edits = removed.map((node) => ({
    start: node.start,
    end: node.end,
    text: source.slice(node.start, node.end).replace(/[^\r\n]/g, " "),
  }));
  for (const definition of definitions) {
    const fn = ast.program.body.find(
      (node) => t.isFunctionDeclaration(node) && node.id.name === definition.entry,
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
    edits.push({
      start: fn.params[0].start,
      end: fn.params[1].end,
      text:
        source.slice(fn.params[1].start, fn.params[1].end) +
        ", " +
        source.slice(fn.params[0].start, fn.params[0].end),
    });
  }
  let input = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    input = input.slice(0, edit.start) + edit.text + input.slice(edit.end);
  }
  const emitted = emitWorkflowScheme(input, {
    entryPoint: null,
    entryInput: true,
    allowEnsure: true,
    allowFinally: true,
  });
  for (const site of Object.values(emitted.debug.sites)) {
    const bindingId =
      site.operation === "elicit"
        ? JSON.stringify(["elicit", site.key])
        : JSON.stringify(["effect", site.name, site.version]);
    if (!bindings.some((binding) => binding.kind === "host" && binding.contract.id === bindingId)) {
      throw Error(`Undeclared workflow exchange: ${bindingId}`);
    }
  }
  const functions = new Set(
    ast.program.body.filter(t.isFunctionDeclaration).map((node) => node.id.name),
  );
  return Object.fromEntries(
    definitions.map(({ name, entry }) => {
      if (!functions.has(entry)) {
        throw Error(`${id}: unknown workflow entry ${entry}`);
      }
      if (!declaredExports.some((e) => e.name === name && e.entry === entry)) {
        throw Error(`${id}: missing export contract for ${name}`);
      }
      return [
        name,
        {
          entry,
          implementation: { format: HOOT_DEFINITION_FORMAT, payload: emitted.scheme },
          source: { id, language: "typescript", text: source },
          exports: declaredExports,
          imports: bindings,
          debug: emitted.debug,
        },
      ];
    }),
  );
}

/** Type-check the supplied source without evaluating its module or emitting JavaScript. */
function typeDiagnostics(source) {
  const filename = resolve(source.id);
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    customConditions: ["development"],
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (path) => resolve(path) === filename || fileExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(path) === filename
      ? ts.createSourceFile(filename, source.text, languageVersion, true)
      : readSource(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const result = {
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.file && diagnostic.start !== undefined) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      result.position = {
        sourceId: diagnostic.file.fileName === filename ? source.id : diagnostic.file.fileName,
        line: position.line + 1,
        column: position.character + 1,
      };
    }
    return result;
  });
}

/** @type {import('../../../packages/workflow-kernel/src/index.ts').WorkflowCompiler} */
export const workflowCompiler = {
  sourceLanguage: "typescript",
  definitionFormat: HOOT_DEFINITION_FORMAT,
  *compile({ source, entry, exports, bindings }) {
    try {
      if (source.language !== "typescript") {
        throw Error("Workflow compiler requires TypeScript source");
      }
      const definitions = compileDefinitions(source.text, source.id, exports, bindings);
      const module = Object.values(definitions).find((d) => d.entry === entry);
      if (!module) {
        throw Error(`Unknown workflow entry: ${entry}`);
      }
      if (exports.some((e) => !definitions[e.name] || definitions[e.name].entry !== e.entry)) {
        throw Error("Unknown declared workflow export");
      }
      const diagnostics = typeDiagnostics(source);
      if (diagnostics.some((d) => d.severity === "error")) {return { ok: false, diagnostics };}
      return { ok: true, module, diagnostics };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          { severity: "error", code: "typescript_workflow_compile", message: error.message },
        ],
      };
    }
  },
};

/** Bundler representation is separate from the portable compiler output.
 * @returns {import("effection").Operation<string>}
 */
export function* compileWorkflowModule(source, id, declarations) {
  const result = yield* workflowCompiler.compile({
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

/** A Rolldown load hook sees TypeScript before built-in lowering. */
export function workflowPlugin(declarations) {
  return {
    name: "sweatpants-workflow",
    async load(id) {
      if (!id.endsWith(".workflow.ts")) {
        return null;
      }
      this.addWatchFile(id);
      return run(function* () {
        const source = yield* call(() => readFile(id, "utf8"));
        const code = yield* compileWorkflowModule(source, id, declarations);
        const stem = basename(id, ".ts");
        return { code, stem };
      }).then(({ code, stem }) => {
        this.emitFile({ type: "asset", fileName: `${stem}.artifact.mjs`, source: code });
        this.emitFile({
          type: "asset",
          fileName: `${stem}.artifact.d.mts`,
          source: [
            'import type { CompiledWorkflow } from "@sweatpants/workflow-kernel";',
            'import type { DurableTool } from "@sweatpants/durable-execution";',
            `import type * as tools from "./${stem}.mjs";`,
            "type Artifact<T> = T extends DurableTool<infer I, infer O> ? CompiledWorkflow<I, O> : never;",
            ...declarations.exports.map(
              (e) => `export declare const ${e.name}: Artifact<typeof tools.${e.name}>;`,
            ),
          ].join("\n"),
        });
        return null;
      });
    },
  };
}
