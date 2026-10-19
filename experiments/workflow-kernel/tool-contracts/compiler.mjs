// Trusted developer module evaluation at build time; the generator is never executed here.
import vm from "node:vm";
import { checkToolDefinition } from "./typecheck.mjs";
import { createRequire } from "node:module";
import * as sdk from "../../../packages/agent-sdk/dist/index.js";
import { createPortableSchemaDescriptor } from "../../../packages/foundation/dist/schema.js";
import { createDurableSchemaRegistry } from "../../../packages/journal-authority/dist/index.js";
import { compileWorkflow } from "../compiled-frames/compiler.mjs";
import { compile } from "../compiled-finally/engine.mjs";
import { hash } from "../compiled-finally/journal.mjs";
import { artifact } from "../compiled-finally/artifact.mjs";
import { textV1 } from "../compiled-finally/schemas.mjs";
const require = createRequire(
    new URL("../../../packages/vite-plugin/package.json", import.meta.url),
);
const babel = require("@babel/core"),
    t = babel.types,
    { z } = require("zod");
const ts = createRequire(new URL("../../../package.json", import.meta.url))("typescript");
export function compileToolDefinition(source) {
    checkToolDefinition(source);
    const ast = babel.parseSync(source, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
    });
    const effectImports = ast.program.body.filter(
        (node) =>
            t.isImportDeclaration(node) &&
            node.source.value === "effection" &&
            node.importKind !== "type",
    );
    const helpers = ast.program.body.flatMap((node) => {
        const declaration = t.isExportNamedDeclaration(node) ? node.declaration : node;
        return t.isFunctionDeclaration(declaration) ? [declaration] : [];
    });
    const sourceYields = [];
    babel.traverse(ast, {
        YieldExpression(path) {
            const call = path.node.argument;
            if (
                t.isCallExpression(call) &&
                t.isMemberExpression(call.callee) &&
                call.callee.property.name === "elicit"
            ) {
                sourceYields.push(path.node.loc);
            }
        },
    });
    let implementation, exportName;
    babel.traverse(ast, {
        CallExpression(path) {
            if (
                !t.isMemberExpression(path.node.callee) ||
                path.node.callee.property.name !== "execute"
            ) {
                return;
            }
            if (implementation) {
                throw Error("Only one tool definition supported");
            }
            const fp = path.get("arguments.0"),
                fn = fp.node;
            if (
                !t.isFunctionExpression(fn) ||
                !fn.generator ||
                fn.async ||
                !fn.body.directives.some((d) => d.value.value === "use workflow")
            ) {
                throw Error("Expected use workflow generator");
            }
            if (fn.params.length !== 2 || fn.params.some((p) => !t.isIdentifier(p))) {
                throw Error("Expected input and context parameters");
            }
            fp.scope.rename(fn.params[1].name, "ctx");
            const declaration = path.findParent((p) => p.isVariableDeclarator());
            if (!declaration?.parentPath.parentPath.isExportNamedDeclaration()) {
                throw Error("Expected named exported tool");
            }
            exportName = declaration.node.id.name;
            implementation = t.functionDeclaration(
                t.identifier("workflow"),
                [t.identifier("ctx"), t.identifier(fn.params[0].name)],
                fn.body,
                true,
                false,
            );
            implementation.loc = fn.loc;
        },
    });
    if (!implementation) {
        throw Error("Missing workflow implementation");
    }
    const module = { exports: {} };
    const js = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const resolve = (id) => {
        if (id === "@sweatpants/agent-sdk") {
            return sdk;
        }
        if (id === "zod") {
            return { z };
        }
        if (id === "effection") {
            return createRequire(new URL("../../../package.json", import.meta.url))("effection");
        }
        throw Error("Unsupported build import " + id);
    };
    vm.runInNewContext("(function(require,module,exports){" + js + "\n})", {})(
        resolve,
        module,
        module.exports,
    );
    const tool = module.exports[exportName];
    if (tool?.execution !== "crank_native") {
        throw Error("Expected real SDK durable tool definition");
    }
    const generated = babel.transformFromAstSync(
        t.file(t.program([...effectImports, ...helpers, implementation])),
        null,
        { configFile: false, babelrc: false, generatorOpts: { retainLines: true } },
    ).code;
    const preview = compileWorkflow(generated, {
        compileScheme: compile,
        allowEnsure: true,
        allowFinally: true,
        allowScopes: true,
        entryInput: true,
    });
    const catalog = [...tool.artifacts.catalog, textV1],
        contracts = {},
        used = {};
    for (const [site, info] of Object.entries(preview.debug.sites)) {
        if (info.operation !== "elicit") {
            continue;
        }
        if (!info.key || !tool.elicits[info.key]) {
            throw Error("Elicitation must use a statically declared key");
        }
        const response = tool.elicits[info.key].response;
        // This increment supports Zod declarations; content uses the actual authored schema.
        const envelope = z.discriminatedUnion("action", [
            z.strictObject({ action: z.literal("accept"), content: response }),
            z.strictObject({ action: z.literal("decline"), reason: z.string().optional() }),
            z.strictObject({ action: z.literal("cancel"), reason: z.string().optional() }),
        ]);
        const authored = tool.manifest.elicits[info.key].response;
        const descriptor = createPortableSchemaDescriptor({
            identity: `compiled:${tool.name}/elicits/${info.key}/completion`,
            role: "elicit_completion",
            version: authored.version,
            vendor: "zod",
            inputProjection: z.toJSONSchema(envelope, { io: "input" }),
            outputProjection: z.toJSONSchema(envelope, { io: "output" }),
            fidelity: { input: "lossless", output: "lossless" },
        });
        catalog.push({ descriptor, schema: envelope });
        contracts[site] = { reply: descriptor.digest, error: textV1.descriptor.digest };
        used[site] = {
            key: info.key,
            responseDigest: authored.digest,
            completionDigest: descriptor.digest,
            binding: tool.bindings.elicits[info.key].id,
        };
    }
    const schemas = createDurableSchemaRegistry(catalog);
    const a = artifact(generated, contracts, schemas, {
            input: tool.manifest.inputSchema.digest,
            output: tool.manifest.outputSchema.digest,
        }),
        { id, ...body } = a;
    // retainLines preserves line identity; restore original authored columns too.
    const remaining = [...sourceYields];
    for (const site of Object.values(body.compiled.debug.sites)) {
        const index = remaining.findIndex((loc) => loc.start.line === site.line);
        if (index >= 0) {
            site.column = remaining[index].start.column;
            remaining.splice(index, 1);
        }
    }
    for (const helper of helpers) {
        body.compiled.debug.locations[helper.id.name] = {
            line: helper.loc.start.line,
            column: helper.loc.start.column,
        };
    }
    body.compiled.debug.locations.workflow = {
        line: implementation.loc.start.line,
        column: implementation.loc.start.column,
    };
    body.tool = { name: tool.name, interfaceDigest: tool.interfaceDigest, elicits: used };
    return { artifact: { ...body, id: hash(body) }, schemas, tool, generated };
}
