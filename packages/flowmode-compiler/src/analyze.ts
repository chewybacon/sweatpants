import type { WorkflowToolDeclaration } from "./types.js";
import type * as Babel from "@babel/core";
import { createRequire } from "node:module";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createPortableSchemaDescriptor, type Json } from "@sweatpants/foundation";
const { parseSync, types: t } = createRequire(import.meta.url)("@babel/core") as typeof Babel;

/** Static SDK admission. Never imports or evaluates the author's module.
 * The result supplies the declarations expected by the lower-level compiler.
 */
export function analyzeWorkflowTools(source: string, id: string): WorkflowToolDeclaration[] {
  if (!source.includes("use workflow")) {
    return [];
  }
  const ast = parseSync(source, {
    filename: id,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  const builders = new Set<string>();
  const schemas = new Set<string>();
  for (const node of ast!.program.body) {
    if (!t.isImportDeclaration(node)) {
      continue;
    }
    for (const spec of node.specifiers) {
      if (!t.isImportSpecifier(spec)) {
        continue;
      }
      if (
        node.source.value === "@sweatpants/agent-sdk/legacy" &&
        (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) ===
          "createDurableTool"
      ) {
        builders.add(spec.local.name);
      }
      if (
        node.source.value === "zod" &&
        (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) === "z"
      ) {
        schemas.add(spec.local.name);
      }
    }
  }
  function fail(node: Babel.types.Node | null | undefined, message: string): never {
    const error = Object.assign(new Error(message), {
      position: {
        sourceId: id,
        line: node?.loc?.start.line ?? 1,
        column: (node?.loc?.start.column ?? 0) + 1,
      },
    });
    throw error;
  }
  function fields(node: Babel.types.Node | null | undefined): Record<string, Babel.types.Node> {
    if (!t.isObjectExpression(node)) {
      return fail(node, "Workflow declarations must be static object literals");
    }
    return Object.fromEntries(
      node.properties.map((p) => {
        if (!t.isObjectProperty(p) || p.computed || p.shorthand) {
          return fail(p, "Unsupported workflow declaration property");
        }
        return [
          t.isIdentifier(p.key)
            ? p.key.name
            : t.isStringLiteral(p.key) || t.isNumericLiteral(p.key)
              ? p.key.value
              : fail(p.key, "Unsupported workflow declaration key"),
          p.value,
        ];
      }),
    );
  }
  function literal(node: Babel.types.Node | null | undefined): string | number | boolean | null {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
      return node.value;
    }
    if (t.isNullLiteral(node)) {
      return null;
    }
    return fail(node, "Expected a literal workflow declaration");
  }
  function jsonSchema(node: Babel.types.Node | null | undefined): Json {
    if (
      !t.isCallExpression(node) ||
      !t.isMemberExpression(node.callee) ||
      node.callee.computed ||
      !t.isIdentifier(node.callee.object) ||
      !t.isIdentifier(node.callee.property) ||
      !schemas.has(node.callee.object.name)
    ) {
      return fail(node, "Unsupported workflow schema; use a static z schema");
    }
    const args = node.arguments;
    switch (node.callee.property.name) {
      case "string":
      case "boolean":
      case "number":
      case "null":
        if (args.length) {
          return fail(node, "Schema options are not supported");
        }
        return { type: node.callee.property.name };
      case "literal":
        if (args.length !== 1) {
          return fail(node, "Expected one literal");
        }
        return { const: literal(args[0]) };
      case "enum":
        if (args.length !== 1 || !t.isArrayExpression(args[0])) {
          return fail(node, "Expected a literal enum array");
        }
        return { enum: args[0].elements.map(literal) };
      case "array":
        if (args.length !== 1) {
          return fail(node, "Expected one array item schema");
        }
        return { type: "array", items: jsonSchema(args[0]) };
      case "object": {
        if (args.length !== 1) {
          return fail(node, "Expected one object shape");
        }
        const shape = fields(args[0]);
        return {
          type: "object",
          properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, jsonSchema(v)])),
          required: Object.keys(shape),
        };
      }
      default:
        return fail(node, "Unsupported workflow schema constructor");
    }
  }
  function descriptor(node: Babel.types.Node | undefined, identity: string, role: string) {
    if (!node) {
      throw new Error(`Workflow requires an explicit ${role} schema`);
    }
    const projection = jsonSchema(node);
    return createPortableSchemaDescriptor({
      identity,
      role,
      version: "1",
      vendor: "flowmode-static-zod",
      inputProjection: projection,
      outputProjection: projection,
      // Projection describes values; the ordinary SDK remains the schema parser.
      fidelity: { input: "explicit", output: "explicit" },
    });
  }
  const result: WorkflowToolDeclaration[] = [];
  for (const node of ast!.program.body) {
    if (!t.isExportNamedDeclaration(node) || !t.isVariableDeclaration(node.declaration)) {
      continue;
    }
    for (const binding of node.declaration.declarations) {
      const execute = binding.init;
      if (
        !t.isCallExpression(execute) ||
        !t.isMemberExpression(execute.callee) ||
        !t.isIdentifier(execute.callee.property, { name: "execute" })
      ) {
        continue;
      }
      let fn: Babel.types.Node | undefined = execute.arguments[0];
      if (t.isIdentifier(fn)) {
        const entryName = fn.name;
        fn = ast!.program.body.find((n) => t.isFunctionDeclaration(n) && n.id?.name === entryName);
      }
      if (
        !fn ||
        !(t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn)) ||
        !fn.body.directives.some((d) => d.value.value === "use workflow")
      ) {
        continue;
      }
      if (!fn.generator || fn.async || !t.isIdentifier(binding.id)) {
        fail(fn, "Workflow execute must be a synchronous generator");
      }
      const chain: Record<string, Babel.types.Node> = {};
      let builder = execute.callee.object;
      while (t.isCallExpression(builder) && t.isMemberExpression(builder.callee)) {
        if (
          builder.callee.computed ||
          !t.isIdentifier(builder.callee.property) ||
          builder.arguments.length !== 1
        ) {
          fail(builder, "Unsupported workflow builder");
        }
        chain[builder.callee.property.name] = builder.arguments[0];
        builder = builder.callee.object;
      }
      if (
        !t.isCallExpression(builder) ||
        !t.isIdentifier(builder.callee) ||
        !builders.has(builder.callee.name)
      ) {
        fail(builder, "Workflow directive requires createDurableTool");
      }
      if (builder.arguments.length !== 2) {
        fail(builder, "Workflow tool requires a name and version");
      }
      const name = literal(builder.arguments[0]);
      if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        fail(builder, "Workflow name must be an identifier");
      }
      const entry = t.isFunctionDeclaration(fn) ? fn.id!.name : name;
      const description = chain.description ? literal(chain.description) : name;
      if (typeof description !== "string") {
        fail(chain.description, "Workflow description must be a string");
      }
      const contract = {
        id: name,
        name,
        description,
        inputSchema: descriptor(chain.parameters, `${name}:input`, "input"),
        outputSchema: descriptor(chain.output, `${name}:output`, "output"),
      };
      const bindings = Object.keys(chain.elicits ? fields(chain.elicits) : {}).map((key) => ({
        kind: "host" as const,
        contract: {
          id: JSON.stringify(["elicit", key]),
          name: key,
          description: `Request ${key}`,
          inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
          outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
        },
      }));
      result.push({
        exportName: binding.id.name,
        entry,
        exports: [{ name: binding.id.name, entry, contract }],
        bindings,
      });
    }
  }
  if (!result.length) {
    // A directive that is not attached to a supported export must not silently run as JS.
    let directive: Babel.types.Directive | undefined;
    const walk = (node: Babel.types.Node | null | undefined): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (t.isDirective(node) && node.value.value === "use workflow") {
        directive = node;
      }
      for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const value: unknown = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          value.forEach((child: Babel.types.Node) => walk(child));
        } else if (value && typeof value === "object") {
          walk(value as Babel.types.Node);
        }
      }
    };
    walk(ast!.program);
    if (directive) {
      fail(
        directive,
        "Workflow directive requires an exported createDurableTool execute generator",
      );
    }
  }
  return result;
}
