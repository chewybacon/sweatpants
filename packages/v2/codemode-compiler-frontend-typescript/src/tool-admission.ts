import ts from "typescript-api";
import { z } from "zod";
import type { TypeScriptToolBuildInput } from "./tool-contracts.ts";

function fail(message: string): never {
  throw new Error(`Tool compilation: ${message}`);
}
const plainString = (value: unknown): value is z.ZodString =>
  value instanceof z.ZodString && !value.def.coerce && !value.def.checks?.length;
export function describeTool(input: TypeScriptToolBuildInput) {
  if (!plainString(input.tool.context)) {
    fail("only plain string tool input is supported");
  }
  const declarations = (selected: TypeScriptToolBuildInput["tool"]["capabilities"]) =>
    Object.fromEntries(
      Object.entries(selected)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([alias, effect]) => {
          const context = effect.context;
          if (
            !effect.id ||
            !(context instanceof z.ZodObject) ||
            context.def.checks?.length ||
            (context.def.catchall && !(context.def.catchall instanceof z.ZodNever)) ||
            Object.keys(context.shape).length !== 1 ||
            !plainString(context.shape.message) ||
            !plainString(effect.response)
          ) {
            fail(`unsupported declaration ${alias}; expected plain { message: string } -> string`);
          }
          return [
            alias,
            {
              id: effect.id,
              context: z.toJSONSchema(context),
              unknownKeys: context.def.catchall ? "reject" : "strip",
              response: z.toJSONSchema(effect.response),
            },
          ];
        }),
    );
  return {
    id: input.tool.id,
    context: z.toJSONSchema(input.tool.context),
    capabilities: declarations(input.tool.capabilities),
    elicits: declarations(input.tool.elicits),
  };
}
export interface AdmittedToolSite {
  readonly key: string;
  readonly effect: string;
  readonly source: { readonly id: string; readonly line: number; readonly column: number };
}
export interface AdmittedTool {
  readonly source: string;
  readonly sites: Readonly<Record<number, AdmittedToolSite>>;
}

/** Static builder/body admission. Does not import modules or invoke the tool. */
export function admitToolSource(input: TypeScriptToolBuildInput): AdmittedTool {
  const diagnostics = ts.transpileModule(input.source.text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) {
    fail("invalid TypeScript syntax");
  }
  const file = ts.createSourceFile(
    input.source.id,
    input.source.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = new Map<string, { name: string; module: string }>();
  let declaration: ts.VariableDeclaration | undefined;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        fail("only named imports are supported");
      }
      const from = statement.moduleSpecifier.text;
      if (!["@sweatpan.ts/tools", "zod"].includes(from)) {
        const resolved = from.startsWith("./") ? from.slice(2).replace(/\.js$/, ".ts") : "";
        if (!resolved || !Object.hasOwn(input.modules, resolved)) {
          fail(`undeclared source import ${from}`);
        }
      }
      for (const binding of statement.importClause.namedBindings.elements) {
        if (binding.isTypeOnly || imports.has(binding.name.text)) {
          fail("duplicate import");
        }
        imports.set(binding.name.text, {
          name: binding.propertyName?.text ?? binding.name.text,
          module: from,
        });
      }
    } else if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.declarationList.flags & ts.NodeFlags.Const &&
      statement.declarationList.declarations.length === 1
    ) {
      if (statement.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword)) {
        fail("unsupported export modifier");
      }
      const candidate = statement.declarationList.declarations[0]!;
      if (
        candidate.type ||
        declaration ||
        !ts.isIdentifier(candidate.name) ||
        candidate.name.text !== input.exportName
      ) {
        fail("one selected exported tool is supported");
      }
      declaration = candidate;
    } else {
      fail("top-level execution is not supported");
    }
  }
  const call = (value: ts.Node | undefined): ts.CallExpression =>
    value && ts.isCallExpression(value) && !value.typeArguments?.length
      ? value
      : fail("expected tool builder call");
  const memberCall = (value: ts.Node | undefined, name: string): ts.CallExpression => {
    const result = call(value);
    if (!ts.isPropertyAccessExpression(result.expression) || result.expression.name.text !== name) {
      fail(`expected .${name}`);
    }
    return result;
  };
  const execute = memberCall(declaration?.initializer, "execute");
  const fn = execute.arguments[0];
  if (
    execute.arguments.length !== 1 ||
    !fn ||
    !ts.isFunctionExpression(fn) ||
    !fn.asteriskToken ||
    fn.modifiers?.length ||
    fn.typeParameters ||
    fn.parameters.length !== 2 ||
    fn.type
  ) {
    fail("execute must be a synchronous generator with two inferred parameters");
  }
  if (
    !fn.parameters.every(
      (p) =>
        ts.isIdentifier(p.name) &&
        !p.type &&
        !p.initializer &&
        !p.dotDotDotToken &&
        !p.questionToken,
    )
  ) {
    fail("unsupported tool parameters");
  }
  const inputName = (fn.parameters[0]!.name as ts.Identifier).text,
    ctxName = (fn.parameters[1]!.name as ts.Identifier).text;
  if (inputName === ctxName) {
    fail("duplicate parameters");
  }
  const first = fn.body.statements[0];
  if (
    !first ||
    !ts.isExpressionStatement(first) ||
    !ts.isStringLiteral(first.expression) ||
    first.expression.text !== "use workflow"
  ) {
    fail("missing use workflow directive");
  }
  let builder: ts.Expression = (execute.expression as ts.PropertyAccessExpression).expression;
  const seen = new Set<string>();
  while (ts.isCallExpression(builder) && ts.isPropertyAccessExpression(builder.expression)) {
    const method = builder.expression.name.text;
    if (
      !["parameters", "capabilities", "elicits"].includes(method) ||
      seen.has(method) ||
      builder.arguments.length !== 1 ||
      builder.typeArguments?.length
    ) {
      fail("unsupported builder configuration");
    }
    seen.add(method);
    const arg = builder.arguments[0]!;
    if (method === "parameters") {
      const schema = memberCall(arg, "string");
      const root = (schema.expression as ts.PropertyAccessExpression).expression;
      if (
        schema.arguments.length ||
        !ts.isIdentifier(root) ||
        imports.get(root.text)?.module !== "zod" ||
        imports.get(root.text)?.name !== "z"
      ) {
        fail("parameters must use imported z.string()");
      }
    } else {
      if (!ts.isObjectLiteralExpression(arg)) {
        fail("declarations must be an object of imported bindings");
      }
      const aliases: string[] = [];
      for (const property of arg.properties) {
        if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer) {
          fail("declaration defaults are unsupported");
        }
        const key = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isPropertyAssignment(property)
            ? property.name
            : undefined;
        const value = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isPropertyAssignment(property)
            ? property.initializer
            : undefined;
        if (
          !key ||
          !ts.isIdentifier(key) ||
          !value ||
          !ts.isIdentifier(value) ||
          !imports.has(value.text) ||
          !imports.get(value.text)!.module.startsWith("./")
        ) {
          fail("declarations must use imported bindings");
        }
        aliases.push(key.text);
      }
      const expected = Object.keys(input.tool[method as "capabilities" | "elicits"]).sort();
      if (
        new Set(aliases).size !== aliases.length ||
        JSON.stringify(aliases.sort()) !== JSON.stringify(expected)
      ) {
        fail("source aliases differ from selected tool contract");
      }
    }
    builder = builder.expression.expression;
  }
  const root = call(builder);
  if (
    !seen.has("parameters") ||
    (!seen.has("capabilities") && Object.keys(input.tool.capabilities).length) ||
    (!seen.has("elicits") && Object.keys(input.tool.elicits).length) ||
    !ts.isIdentifier(root.expression) ||
    imports.get(root.expression.text)?.module !== "@sweatpan.ts/tools" ||
    imports.get(root.expression.text)?.name !== "defineTool" ||
    root.arguments.length !== 1 ||
    !ts.isStringLiteral(root.arguments[0]!) ||
    root.arguments[0].text !== input.tool.id
  ) {
    fail("source must declare the selected public tool");
  }

  type Binding = { emitted: string; kind: "string" | "outcome" };
  let serial = 0;
  const sites: { token: string; request: string; site: AdmittedToolSite }[] = [];
  function exchange(node: ts.YieldExpression, env: Map<string, Binding>): string {
    if (
      !node.asteriskToken ||
      !node.expression ||
      !ts.isCallExpression(node.expression) ||
      node.expression.typeArguments?.length
    ) {
      fail("only delegated declared effects may yield");
    }
    const invocation = node.expression,
      callee = invocation.expression;
    let alias: string, kind: "capabilities" | "elicits", request: ts.Expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isPropertyAccessExpression(callee.expression) &&
      ts.isIdentifier(callee.expression.expression) &&
      callee.expression.expression.text === ctxName &&
      callee.expression.name.text === "capabilities" &&
      invocation.arguments.length === 1
    ) {
      alias = callee.name.text;
      kind = "capabilities";
      request = invocation.arguments[0]!;
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === ctxName &&
      callee.name.text === "elicit" &&
      invocation.arguments.length === 2 &&
      ts.isStringLiteral(invocation.arguments[0]!)
    ) {
      alias = invocation.arguments[0].text;
      kind = "elicits";
      request = invocation.arguments[1]!;
    } else {
      return fail("unsupported context call");
    }
    const definition = input.tool[kind][alias];
    if (!Object.hasOwn(input.tool[kind], alias) || !definition) {
      fail("undeclared effect");
    }
    if (!ts.isObjectLiteralExpression(request) || request.properties.length !== 1) {
      fail("effect input must contain message only");
    }
    const property = request.properties[0]!;
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      property.name.text !== "message"
    ) {
      fail("effect input must contain message only");
    }
    const payload = expression(property.initializer, env);
    if (payload.kind !== "string") {
      fail("effect message must be a string");
    }
    const location = file.getLineAndCharacterOfPosition(node.getStart(file));
    const token = `__WORKFLOW_SITE_${sites.length}__`;
    sites.push({
      token,
      request: `yield ["effect", ${JSON.stringify(definition.id)}, ${payload.text}]`,
      site: {
        key: `${kind}:${alias}`,
        effect: definition.id,
        source: { id: input.source.id, line: location.line + 1, column: location.character + 1 },
      },
    });
    return token;
  }
  function expression(
    node: ts.Expression,
    env: Map<string, Binding>,
  ): { text: string; kind: "string" | "outcome" | "boolean" } {
    if (ts.isParenthesizedExpression(node)) {
      return expression(node.expression, env);
    }
    if (ts.isStringLiteral(node)) {
      return { text: JSON.stringify(node.text), kind: "string" };
    }
    if (ts.isIdentifier(node)) {
      const value = env.get(node.text);
      if (!value) {
        return fail(`unbound value ${node.text}`);
      }
      return { text: value.emitted, kind: value.kind };
    }
    if (ts.isYieldExpression(node)) {
      return { text: `(${exchange(node, env)})`, kind: "outcome" };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const value = env.get(node.expression.text);
      if (value?.kind !== "outcome" || !["ok", "value"].includes(node.name.text)) {
        fail("only Outcome ok/value reads are supported");
      }
      return {
        text: `${value.emitted}.${node.name.text}`,
        kind: node.name.text === "ok" ? "boolean" : "string",
      };
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = expression(node.left, env),
        right = expression(node.right, env);
      if (left.kind !== "string" || right.kind !== "string") {
        fail("only string concatenation is supported");
      }
      return { text: `(${left.text} + ${right.text})`, kind: "string" };
    }
    return fail(`unsupported expression ${ts.SyntaxKind[node.kind]}`);
  }
  function statements(nodes: readonly ts.Statement[], outer: Map<string, Binding>): string {
    const env = new Map(outer);
    return nodes
      .map((node): string => {
        if (
          ts.isVariableStatement(node) &&
          node.declarationList.flags & ts.NodeFlags.Const &&
          node.declarationList.declarations.length === 1
        ) {
          const item = node.declarationList.declarations[0]!;
          if (
            !ts.isIdentifier(item.name) ||
            !item.initializer ||
            item.type ||
            item.name.text === ctxName ||
            env.has(item.name.text)
          ) {
            fail("only fresh inferred const bindings are supported");
          }
          const value = expression(item.initializer, env);
          if (value.kind === "boolean") {
            fail("inspect Outcome.ok directly");
          }
          const emitted = `v${serial++}`;
          env.set(item.name.text, { emitted, kind: value.kind });
          return `const ${emitted} = ${value.text};`;
        }
        if (ts.isReturnStatement(node) && node.expression) {
          const value = expression(node.expression, env);
          if (value.kind !== "string") {
            fail("this profile requires a string result");
          }
          return `return ${value.text};`;
        }
        if (
          ts.isIfStatement(node) &&
          ts.isBlock(node.thenStatement) &&
          node.elseStatement &&
          ts.isBlock(node.elseStatement)
        ) {
          const test = expression(node.expression, env);
          if (test.kind !== "boolean") {
            fail("conditions must inspect Outcome.ok");
          }
          return `if (${test.text}) {${statements(node.thenStatement.statements, env)}} else {${statements(node.elseStatement.statements, env)}}`;
        }
        if (ts.isTryStatement(node) && !node.catchClause && node.finallyBlock) {
          return `try {${statements(node.tryBlock.statements, env)}} finally {${statements(node.finallyBlock.statements, env)}}`;
        }
        if (ts.isExpressionStatement(node) && ts.isYieldExpression(node.expression)) {
          return `${expression(node.expression, env).text};`;
        }
        return fail(`unsupported statement ${ts.SyntaxKind[node.kind]}`);
      })
      .join("\n");
  }
  let normalized = `export function* workflow(input: string): Generator<string[], string, {ok:true;value:string}|{ok:false;error:unknown}> {\n${statements(fn.body.statements.slice(1), new Map([[inputName, { emitted: "input", kind: "string" }]]))}\n}`;
  const mapped: Record<number, AdmittedToolSite> = {};
  // Substitute in source order; generated tokens cannot occur in renamed identifiers.
  for (const site of sites) {
    const offset = normalized.indexOf(site.token);
    if (offset < 0 || normalized.indexOf(site.token, offset + site.token.length) !== -1) {
      fail("ambiguous generated effect marker");
    }
    mapped[offset] = site.site;
    normalized =
      normalized.slice(0, offset) + site.request + normalized.slice(offset + site.token.length);
  }
  return { source: normalized, sites: mapped };
}
