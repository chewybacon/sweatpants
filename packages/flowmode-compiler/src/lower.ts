import type * as Babel from "@babel/core";
import { createRequire } from "node:module";
import { validateCleanupPolicy } from "./cleanup-policy.js";
import type { WorkflowEntry } from "./types.js";
import {
  expressionType,
  jsonType,
  type Binding,
  type SchemeExpr,
  type SchemeFunction,
  type Id,
  type Origin,
  type SchemeBlock,
  type SchemeStatement,
  type ValueType,
  type SchemeProgram,
} from "./scheme-ir.js";
import { verifySchemeIR } from "./verify.js";
const babel = createRequire(import.meta.url)("@babel/core") as typeof Babel;
const t = babel.types;
export interface LowerOptions {
  allowEnsure?: boolean;
  allowFinally?: boolean;
  allowScopes?: boolean;
  entryInput?: boolean;
  entryPoint?: string | null;
  sourceId?: string;
  types?: WeakMap<Babel.types.Node, ValueType>;
  definitions?: WorkflowEntry[];
  installedEffects?: readonly {
    module: string;
    export: string;
    definition: { name: string; version: string };
  }[];
}
/** Lower admitted syntax to semantic operations. No target syntax is constructed here. */
export function lowerWorkflow(
  source: string | Babel.types.File,
  options: LowerOptions = {},
): SchemeProgram {
  const {
    allowEnsure = false,
    allowFinally = false,
    allowScopes = false,
    entryInput = false,
    entryPoint = "workflow",
    installedEffects = [],
    definitions,
  } = options;
  const ast =
    typeof source === "string"
      ? babel.parseSync(source, {
          filename: options.sourceId,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript"] },
        })!
      : source;
  let current: Babel.types.Node = ast.program;
  const origin = (node: Babel.types.Node = current): Origin => ({
    sourceId: node.loc?.filename ?? options.sourceId ?? "workflow.ts",
    line: node.loc?.start.line ?? 1,
    column: node.loc?.start.column ?? 0,
  });
  function fail(message: string): never {
    const p = origin();
    throw Object.assign(Error(message), {
      loc: { ...p, file: p.sourceId },
      position: { ...p, column: p.column + 1 },
    });
  }
  let serial = 0;
  const id = <K extends string>(kind: K): Id<K> => `${kind}_${serial++}` as Id<K>;
  const ensureNames = new Set<string>(),
    scopeNames = new Set<string>(),
    apiNames = new Set<string>();
  const effects = new Map<string, { name: string; version: string }>();
  if (allowScopes && !allowFinally) {
    fail("Scopes require the explicit unwind backend");
  }
  for (const imp of ast.program.body.filter((n) => t.isImportDeclaration(n))) {
    current = imp;
    if (imp.importKind === "type") {
      continue;
    }
    const installed = installedEffects.filter((b) => b.module === imp.source.value);
    for (const spec of imp.specifiers) {
      if (t.isImportSpecifier(spec) && spec.importKind === "type") {
        continue;
      }
      if (!t.isImportSpecifier(spec)) {
        fail("Unsupported import");
      }
      const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      const binding = installed.find((b) => b.export === imported);
      if (installed.length) {
        if (!binding || effects.has(spec.local.name)) {
          fail("Unknown installed effect import");
        }
        if (!binding.definition?.name || !binding.definition?.version) {
          fail("Invalid installed effect binding");
        }
        effects.set(spec.local.name, binding.definition);
      } else if (imp.source.value === "effection" && imported === "ensure" && allowEnsure) {
        ensureNames.add(spec.local.name);
      } else if (imp.source.value === "effection" && imported === "scoped" && allowScopes) {
        scopeNames.add(spec.local.name);
      } else {
        fail("Unsupported import");
      }
      apiNames.add(spec.local.name);
    }
    if (!imp.specifiers.length) {
      fail("Unsupported import");
    }
  }
  const declarations = ast.program.body.filter(
    (n) =>
      !t.isImportDeclaration(n) && !t.isTSInterfaceDeclaration(n) && !t.isTSTypeAliasDeclaration(n),
  );
  const functions = new Map<string, SchemeFunction>();
  const functionNodes = new Map<string, Babel.types.FunctionDeclaration>();
  function annotation(node: Babel.types.Identifier): ValueType {
    const checked = options.types?.get(node);
    if (checked) {
      return checked;
    }
    const ann = t.isTSTypeAnnotation(node.typeAnnotation)
      ? node.typeAnnotation.typeAnnotation
      : undefined;
    if (t.isTSStringKeyword(ann)) {
      return { kind: "string" };
    }
    if (t.isTSNumberKeyword(ann)) {
      return { kind: "number" };
    }
    if (t.isTSBooleanKeyword(ann)) {
      return { kind: "boolean" };
    }
    if (t.isTSNullKeyword(ann)) {
      return { kind: "null" };
    }
    return jsonType;
  }
  function skeleton(
    node:
      | Babel.types.FunctionDeclaration
      | Babel.types.FunctionExpression
      | Babel.types.ArrowFunctionExpression,
    name: string,
  ): SchemeFunction {
    const params = new Set<string>();
    return {
      id: id("function"),
      name,
      kind: node.generator ? "workflow" : "sync",
      parameters: node.params.map((p) => {
        current = p;
        if (!t.isIdentifier(p) || params.has(p.name)) {
          fail("Unsupported parameter");
        }
        if (apiNames.has(p.name)) {
          fail("Shadowed workflow API import");
        }
        params.add(p.name);
        return { id: id("value"), name: p.name, mutable: false, type: annotation(p) };
      }),
      result: jsonType,
      captures: [],
      scope: id("scope"),
      body: { statements: [], exit: "fallthrough" },
      origin: origin(node),
    };
  }
  for (const node of declarations) {
    current = node;
    if (!t.isFunctionDeclaration(node) || !node.id || node.async) {
      fail("Expected named function* with use workflow directive");
    }
    const isEntry = definitions ? definitions.some((d) => d.entry === node.id!.name) : true;
    if (
      isEntry &&
      (!node.generator || !node.body.directives.some((d) => d.value.value === "use workflow"))
    ) {
      fail("Expected named function* with use workflow directive");
    }
    if (apiNames.has(node.id.name)) {
      fail("Shadowed Effection import");
    }
    if (functions.has(node.id.name)) {
      fail("Duplicate function");
    }
    validateCleanupPolicy(node, t);
    const fn = skeleton(node, node.id.name);
    if (!definitions && fn.parameters[0]?.name !== "ctx") {
      fail("First parameter must be ctx");
    }
    functions.set(node.id.name, fn);
    functionNodes.set(node.id.name, node);
  }
  const program: SchemeProgram = {
    functions: [...functions.values()],
    debug: { sites: {}, locations: {} },
    entryInput,
    entryPoint,
  };
  const byId = new Map(program.functions.map((fn) => [fn.id, fn]));
  const completes = (s: Babel.types.Statement | undefined): boolean =>
    t.isReturnStatement(s) ||
    t.isThrowStatement(s) ||
    (t.isTryStatement(s) && !s.handler && completes(s.block.body.at(-1)));
  function lowerFunction(
    fn: SchemeFunction,
    node:
      | Babel.types.FunctionDeclaration
      | Babel.types.FunctionExpression
      | Babel.types.ArrowFunctionExpression,
    inherited: Map<string, Binding>,
    path: string,
    cleanup = false,
  ): void {
    const env = new Map(inherited);
    for (const p of fn.parameters) {
      if (functions.has(p.name)) {
        fail("Shadowed workflow function");
      }
      env.set(p.name, p);
    }
    const captures = new Map<string, Binding>();
    const inheritedIds = new Set([...inherited.values()].map((b) => b.id));
    function read(name: string): Binding {
      const b = env.get(name);
      if (!b) {
        fail("Unbound local " + name);
      }
      if (inheritedIds.has(b.id)) {
        captures.set(b.id, b);
      }
      return b;
    }
    const loops: Id<"loop">[] = [];
    function closure(
      n: Babel.types.FunctionExpression | Babel.types.ArrowFunctionExpression,
      site: string,
      isCleanup = false,
    ): SchemeFunction {
      if (n.async || (t.isFunctionExpression(n) && n.id)) {
        fail("Only anonymous synchronous workflow closures are supported");
      }
      validateCleanupPolicy(n, t);
      const child = skeleton(n, `${fn.name}/closure`);
      byId.set(child.id, child);
      lowerFunction(child, n, env, site, isCleanup);
      for (const b of child.captures) {
        if (inheritedIds.has(b.id)) {
          captures.set(b.id, b);
        }
      }
      return child;
    }
    function expr(n: Babel.types.Node | null | undefined, site: string): SchemeExpr {
      if (!n) {
        fail("Missing expression");
      }
      current = n;
      const o = origin(n);
      if (t.isNullLiteral(n)) {
        return { kind: "literal", value: null, origin: o };
      }
      if (t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isBooleanLiteral(n)) {
        return { kind: "literal", value: n.value, origin: o };
      }
      if (t.isIdentifier(n)) {
        const global = functions.get(n.name);
        if (global) {
          lowerGlobal(global);
        }
        return global
          ? { kind: "function", target: global.id, origin: o }
          : { kind: "read", binding: read(n.name), origin: o };
      }
      if (entryInput && t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
        return {
          kind: "json-field",
          object: expr(n.object, site),
          key: n.property.name,
          origin: o,
        };
      }
      if (
        allowFinally &&
        t.isBinaryExpression(n) &&
        ["+", "-", "<", ">", "<=", ">=", "===", "!=="].includes(n.operator)
      ) {
        const value: SchemeExpr = {
          kind: (n.operator === "+"
            ? "js-add"
            : n.operator === "===" || n.operator === "!=="
              ? "="
              : n.operator) as "js-add" | "-" | "<" | ">" | "<=" | ">=" | "=",
          left: expr(n.left, site),
          right: expr(n.right, site),
          origin: o,
        };
        return n.operator === "!==" ? { kind: "not", value, origin: o } : value;
      }
      if (allowFinally && t.isUnaryExpression(n, { operator: "!" })) {
        return {
          kind: "not",
          value: { kind: "truthy", value: expr(n.argument, site), origin: o },
          origin: o,
        };
      }
      if (
        allowFinally &&
        t.isAssignmentExpression(n, { operator: "=" }) &&
        t.isIdentifier(n.left)
      ) {
        const binding = read(n.left.name),
          value = expr(n.right, site);
        if (binding.type.kind === "callable" || expressionType(value, byId).kind === "callable") {
          fail("Callable bindings must be immutable");
        }
        if (!binding.mutable) {
          fail("Assignment requires mutable local");
        }
        return { kind: "set!", binding, value, origin: o };
      }
      if (t.isObjectExpression(n)) {
        return {
          kind: "object",
          entries: n.properties.map((p): SchemeExpr => {
            if (!t.isObjectProperty(p) || p.computed) {
              fail("Unsupported object property");
            }
            return {
              kind: "list",
              origin: origin(p),
              values: [
                {
                  kind: "literal",
                  value: String(
                    t.isIdentifier(p.key) ? p.key.name : "value" in p.key ? p.key.value : undefined,
                  ),
                  origin: origin(p.key),
                },
                expr(p.value, site),
              ],
            };
          }),
          origin: o,
        };
      }
      if (t.isArrayExpression(n)) {
        return { kind: "list", values: n.elements.map((e) => expr(e, site)), origin: o };
      }
      if (allowFinally && (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n))) {
        return { kind: "lambda", fn: closure(n, `${site}/lambda`), origin: o };
      }
      if (
        allowFinally &&
        t.isCallExpression(n) &&
        t.isIdentifier(n.callee) &&
        (env.has(n.callee.name) || functions.has(n.callee.name))
      ) {
        const callee = expr(n.callee, site),
          type = expressionType(callee, byId);
        if (type.kind === "callable" && type.callable === "sync") {
          return {
            kind: "apply",
            callable: "sync",
            callee,
            args: n.arguments.map((a) => expr(a, site)),
            origin: o,
          };
        }
      }
      if (t.isYieldExpression(n) && n.delegate && t.isCallExpression(n.argument)) {
        if (fn.kind !== "workflow") {
          fail("Delegation requires a workflow function");
        }
        const call = n.argument,
          c = call.callee;
        if (
          t.isMemberExpression(c) &&
          !c.computed &&
          t.isIdentifier(c.object, { name: "ctx" }) &&
          t.isIdentifier(c.property) &&
          ["effect", "elicit"].includes(c.property.name)
        ) {
          if (!env.has("ctx")) {
            fail("Unbound local ctx");
          }
          read("ctx");
          if (program.debug.sites[site]) {
            fail("Duplicate effect site");
          }
          const args: Babel.types.Node[] = [...call.arguments];
          if (c.property.name === "effect") {
            const definition = t.isIdentifier(args[0]) && effects.get(args[0].name);
            if (!definition || args.length !== 2) {
              fail("ctx.effect requires an installed effect and input");
            }
            program.debug.sites[site] = {
              function: fn.name,
              ...o,
              operation: "effect",
              ...definition,
            };
            return {
              kind: "yield-at",
              site,
              request: {
                kind: "list",
                origin: o,
                values: [
                  { kind: "literal", value: "effect", origin: o },
                  { kind: "literal", value: definition.name, origin: o },
                  { kind: "literal", value: definition.version, origin: o },
                  expr(args[1], site),
                ],
              },
              origin: o,
            };
          }
          program.debug.sites[site] = {
            function: fn.name,
            ...o,
            operation: "elicit",
            // CONDITIONAL-SPREAD: Only literal exchange keys have a static debug binding.
            ...(t.isStringLiteral(args[0]) ? { key: args[0].value } : {}),
          };
          if (t.isObjectExpression(args[1])) {
            const ps = args[1].properties;
            if (
              ps.length !== 1 ||
              !t.isObjectProperty(ps[0]) ||
              ps[0].computed ||
              !t.isIdentifier(ps[0].key, { name: "message" })
            ) {
              fail("Compiled elicitation currently supports only { message }");
            }
            args[1] = ps[0].value;
          }
          return {
            kind: "yield-at",
            site,
            request: {
              kind: "list",
              origin: o,
              values: [
                { kind: "literal", value: "elicit", origin: o },
                ...args.map((a) => expr(a, site)),
              ],
            },
            origin: o,
          };
        }
        if (t.isIdentifier(c) && (scopeNames.has(c.name) || ensureNames.has(c.name))) {
          const callback = call.arguments[0],
            scoped = scopeNames.has(c.name);
          if (
            call.arguments.length !== 1 ||
            !t.isFunctionExpression(callback) ||
            !callback.generator ||
            callback.async ||
            callback.params.length
          ) {
            fail(`${scoped ? "scoped" : "ensure"} requires a zero-argument generator callback`);
          }
          if (
            !allowFinally &&
            !scoped &&
            (!callback.body.body.length ||
              !callback.body.body.every((s) => t.isExpressionStatement(s)))
          ) {
            fail("Cleanup supports effect statements only in this spike");
          }
          const child = closure(callback, `${site}/${scoped ? "scope" : "cleanup"}`, !scoped);
          if (scoped) {
            program.debug.sites[site] = { function: fn.name, ...o, operation: "scoped" };
            return { kind: "scope", site, fn: child, origin: o };
          }
          return { kind: "ensure", owner: fn.scope, fn: child, origin: o };
        }
        if (t.isIdentifier(c) && (env.has(c.name) || functions.has(c.name))) {
          const callee = expr(c, site),
            type = expressionType(callee, byId);
          if (type.kind === "callable" && type.callable === "workflow") {
            if (call.arguments.length !== type.parameters.length) {
              fail("Helper arity mismatch");
            }
            return {
              kind: "apply",
              callable: "workflow",
              callee,
              args: call.arguments.map((a) => expr(a, site)),
              origin: o,
            };
          }
        }
      }
      fail("Unsupported expression " + n.type);
    }
    function region(xs: Babel.types.Statement[], path: string): SchemeBlock {
      const output: SchemeStatement[] = [];
      const saved = new Map(env);
      for (const [i, s] of xs.entries()) {
        current = s;
        const o = origin(s),
          site = `${path}/statement-${i}`;
        if (
          t.isVariableDeclaration(s) &&
          (s.kind === "const" || (allowFinally && s.kind === "let")) &&
          s.declarations.length === 1
        ) {
          const d = s.declarations[0];
          if (
            !t.isIdentifier(d.id) ||
            env.has(d.id.name) ||
            apiNames.has(d.id.name) ||
            functions.has(d.id.name)
          ) {
            fail("Unsupported binding");
          }
          const value = expr(d.init, `${path}/${d.id.name}`),
            type = expressionType(value, byId);
          if (type.kind === "callable" && s.kind !== "const") {
            fail("Callable bindings must be immutable");
          }
          const binding: Binding = {
            id: s.kind === "let" ? id("cell") : id("value"),
            name: d.id.name,
            mutable: s.kind === "let",
            type: s.kind === "let" ? annotation(d.id) : type,
          };
          env.set(binding.name, binding);
          output.push({ kind: "define", binding, value, origin: o });
        } else if (allowFinally && t.isWhileStatement(s)) {
          const loop = id("loop"),
            test: SchemeExpr = { kind: "truthy", value: expr(s.test, site), origin: o };
          loops.push(loop);
          const body = region(t.isBlockStatement(s.body) ? s.body.body : [s.body], `${site}/loop`);
          loops.pop();
          output.push({ kind: "while", id: loop, test, body, origin: o });
        } else if (allowFinally && t.isIfStatement(s)) {
          const test: SchemeExpr = { kind: "truthy", value: expr(s.test, site), origin: o };
          const branch = (n: Babel.types.Statement | null | undefined, suffix: string) =>
            region(n ? (t.isBlockStatement(n) ? n.body : [n]) : [], `${site}/${suffix}`);
          output.push({
            kind: "if",
            test,
            consequent: branch(s.consequent, "then"),
            otherwise: branch(s.alternate, "else"),
            origin: o,
          });
        } else if (allowFinally && (t.isBreakStatement(s) || t.isContinueStatement(s))) {
          if (!loops.length || s.label) {
            fail("Only unlabeled loop exits supported");
          }
          output.push({
            kind: t.isBreakStatement(s) ? "break" : "continue",
            target: loops.at(-1)!,
            origin: o,
          });
        } else if ((allowEnsure || allowFinally) && t.isExpressionStatement(s)) {
          output.push({ kind: "expression", value: expr(s.expression, site), origin: o });
        } else if (allowFinally && t.isTryStatement(s)) {
          if (s.handler || !s.finalizer) {
            fail("Only try/finally supported");
          }
          output.push({
            kind: "try-finally",
            body: region(s.block.body, `${site}/try`),
            cleanup: region(s.finalizer.body, `${site}/finally`),
            origin: o,
          });
        } else if (allowFinally && t.isThrowStatement(s)) {
          output.push({ kind: "workflow-throw", value: expr(s.argument, site), origin: o });
        } else if (t.isReturnStatement(s) && (allowFinally || i === xs.length - 1)) {
          output.push({
            kind: allowFinally ? "workflow-return" : "tail-value",
            target: fn.id,
            value: expr(s.argument, `${path}/return`),
            origin: o,
          });
        } else {
          fail("Unsupported statement " + s.type);
        }
      }
      env.clear();
      saved.forEach((b, name) => env.set(name, b));
      return { statements: output, exit: "fallthrough" };
    }
    current = node;
    if (t.isBlockStatement(node.body)) {
      fn.body = region(node.body.body, path);
      if (
        !cleanup &&
        !(allowFinally
          ? completes(node.body.body.at(-1))
          : t.isReturnStatement(node.body.body.at(-1)))
      ) {
        fail("Explicit final return or throw required");
      }
    } else {
      fn.body = {
        statements: [
          {
            kind: allowFinally ? "workflow-return" : "tail-value",
            target: fn.id,
            value: expr(node.body, `${path}/return`),
            origin: origin(node.body),
          },
        ],
        exit: "fallthrough",
      };
    }
    fn.captures = [...captures.values()];
    const returns = fn.body.statements.filter(
      (s) => s.kind === "workflow-return" || s.kind === "tail-value",
    );
    if (returns.length === 1) {
      fn.result = expressionType(returns[0].value, byId);
    }
  }
  const lowered = new Set<string>(),
    lowering = new Set<string>();
  function lowerGlobal(fn: SchemeFunction): void {
    if (lowered.has(fn.id) || lowering.has(fn.id)) {
      return;
    }
    lowering.add(fn.id);
    const savedNode = current;
    lowerFunction(fn, functionNodes.get(fn.name)!, new Map(), fn.name);
    current = savedNode;
    lowering.delete(fn.id);
    lowered.add(fn.id);
    program.debug.locations[fn.name] =
      fn.origin.sourceId === (options.sourceId ?? "workflow.ts")
        ? { line: fn.origin.line, column: fn.origin.column }
        : fn.origin;
  }
  for (const fn of program.functions) {
    lowerGlobal(fn);
  }
  if (entryPoint !== null && !functions.has(entryPoint)) {
    fail("Unknown entry point");
  }
  verifySchemeIR(program);
  return program;
}
