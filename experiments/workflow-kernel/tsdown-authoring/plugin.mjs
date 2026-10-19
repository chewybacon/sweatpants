import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { emitWorkflowScheme } from "../scheme-compiler/emit.mjs";
const babel = createRequire(new URL("../../../packages/vite-plugin/package.json", import.meta.url))(
    "@babel/core",
);

/** Shared build transform: no module evaluation or bundler state. */
export function compileWorkflowModule(source, id) {
    const ast = babel.parseSync(source, {
        filename: id,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
    });
    const t = babel.types;
    let marker;
    const definitions = [];
    const removed = [];
    for (const node of ast.program.body) {
        if (t.isImportDeclaration(node) && node.source.value === "./definition.ts") {
            if (
                node.specifiers.length !== 1 ||
                !t.isImportSpecifier(node.specifiers[0]) ||
                node.specifiers[0].imported.name !== "defineCompiledWorkflow"
            ) {
                throw Error(`${id}: expected the defineCompiledWorkflow import`);
            }
            marker = node.specifiers[0].local.name;
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
                    !t.isIdentifier(init.callee, { name: marker }) ||
                    init.arguments.length !== 1 ||
                    !t.isIdentifier(init.arguments[0])
                ) {
                    throw Error(`${id}: expected defineCompiledWorkflow(namedGenerator)`);
                }
                definitions.push({ name: binding.id.name, entry: init.arguments[0].name });
            }
            removed.push(node);
        }
    }
    if (!definitions.length) {
        throw Error(`${id}: no compiled workflow definitions`);
    }
    // Blank removed nodes to preserve original line/column locations for inspection.
    let input = source;
    for (const node of removed.toReversed()) {
        input =
            input.slice(0, node.start) +
            input.slice(node.start, node.end).replace(/[^\r\n]/g, " ") +
            input.slice(node.end);
    }
    const emitted = emitWorkflowScheme(input, {
        entryPoint: null,
        entryInput: true,
        allowEnsure: true,
        allowFinally: true,
    });
    const functions = new Set(
        ast.program.body.filter(t.isFunctionDeclaration).map((node) => node.id.name),
    );
    return definitions
        .map(({ name, entry }) => {
            if (!functions.has(entry)) {
                throw Error(`${id}: unknown workflow entry ${entry}`);
            }
            return `export const ${name} = ${JSON.stringify({ kind: "compiled-workflow", entry, ...emitted, source })};`;
        })
        .join("\n");
}

/** A Rolldown load hook sees TypeScript before built-in lowering. */
export function workflowPlugin() {
    return {
        name: "sweatpants-workflow",
        async load(id) {
            if (!id.endsWith(".workflow.ts")) {
                return null;
            }
            this.addWatchFile(id);
            return { code: compileWorkflowModule(await readFile(id, "utf8"), id), map: null };
        },
    };
}
