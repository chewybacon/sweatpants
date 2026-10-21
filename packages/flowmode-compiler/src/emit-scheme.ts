import type * as Babel from "@babel/core";
// Compile the supported developer generator subset to workflow Scheme and source metadata.
import { createRequire } from "node:module";
import { validateCleanupPolicy } from "./cleanup-policy.js";
import { schemeString } from "./scheme-data/values.js";
import type { EmittedWorkflowDebug } from "./types.js";
const babel = createRequire(import.meta.url)("@babel/core") as typeof Babel;
const t = babel.types;
export interface SchemeEmissionOptions {
  allowEnsure?: boolean;
  allowFinally?: boolean;
  allowScopes?: boolean;
  entryInput?: boolean;
  entryPoint?: string | null;
  installedEffects?: readonly {
    module: string;
    export: string;
    definition: { name: string; version: string };
  }[];
}
type Callable = { kind: "generator" | "sync"; result?: Callable };
export function emitWorkflowScheme(
  source: string,
  {
    allowEnsure = false,
    allowFinally = false,
    allowScopes = false,
    entryInput = false,
    entryPoint = "workflow",
    installedEffects = [],
  }: SchemeEmissionOptions = {},
) {
  const ast = babel.parseSync(source, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  let currentNode: Babel.types.Node = ast!.program;
  function sourceError(message: string) {
    const error = Object.assign(new Error(message), { loc: currentNode.loc!.start });
    return error;
  }
  const imports = ast!.program.body.filter((n) => t.isImportDeclaration(n));
  if (allowScopes && !allowFinally) {
    throw sourceError("Scopes require the explicit unwind backend");
  }
  const ensureNames = new Set<string>(),
    scopeNames = new Set<string>(),
    apiNames = new Set<string>();
  const effectNames = new Map<string, { name: string; version: string }>();
  for (const imp of imports) {
    const bindings = installedEffects.filter((binding) => binding.module === imp.source.value);
    if (bindings.length) {
      for (const spec of imp.specifiers) {
        const binding =
          t.isImportSpecifier(spec) &&
          bindings.find(
            (b) =>
              b.export ===
              (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value),
          );
        if (!binding || effectNames.has(spec.local.name)) {
          throw sourceError("Unknown installed effect import");
        }
        if (!binding.definition?.name || !binding.definition?.version) {
          throw sourceError("Invalid installed effect binding");
        }
        effectNames.set(spec.local.name, binding.definition);
        apiNames.add(spec.local.name);
      }
      continue;
    }
    if ((!allowEnsure && !allowScopes) || imp.source.value !== "effection") {
      throw sourceError("Unsupported import");
    }
    for (const spec of imp.specifiers) {
      if (t.isImportSpecifier(spec) && spec.importKind === "type") {
        continue;
      }
      if (!t.isImportSpecifier(spec)) {
        throw sourceError("Unsupported import");
      }
      if (
        (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) === "ensure" &&
        allowEnsure
      ) {
        ensureNames.add(spec.local.name);
      } else if (
        (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) === "scoped" &&
        allowScopes
      ) {
        scopeNames.add(spec.local.name);
      } else {
        throw sourceError("Unsupported import");
      }
      apiNames.add(spec.local.name);
    }
  }
  const declarations = ast!.program.body.filter((n) => !t.isImportDeclaration(n));
  const functions: Babel.types.FunctionDeclaration[] = [];
  const names = new Set<string>();
  for (const f of declarations) {
    if (
      !t.isFunctionDeclaration(f) ||
      !f.id ||
      !f.generator ||
      f.async ||
      !f.body.directives.some((d) => d.value.value === "use workflow")
    ) {
      throw sourceError("Expected named function* with use workflow directive");
    }
    functions.push(f);
    validateCleanupPolicy(f, t);
    if (apiNames.has(f.id!.name)) {
      throw sourceError("Shadowed Effection import");
    }
    if (names.has(f.id!.name)) {
      throw sourceError("Duplicate function");
    }
    names.add(f.id!.name);
  }
  const sites: EmittedWorkflowDebug["sites"] = {},
    locations: EmittedWorkflowDebug["locations"] = {};
  function emitFunction(f: Babel.types.FunctionDeclaration): string {
    currentNode = f;
    const name = f.id!.name,
      bound = new Set<string>(),
      mutable = new Set<string>();
    const callables = new Map<string, Callable>(
      [...names].map((id) => [id, { kind: "generator" }]),
    );
    function callableOf(node: Babel.types.Node | null | undefined): Callable | undefined {
      if (t.isIdentifier(node)) {
        return callables.get(node.name);
      }
      if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
        const last = t.isBlockStatement(node.body) ? node.body.body.at(-1) : undefined;
        const result = t.isBlockStatement(node.body)
          ? t.isReturnStatement(last) || t.isThrowStatement(last)
            ? last.argument
            : undefined
          : node.body;
        return {
          kind: node.generator ? "generator" : "sync",
          result: result ? callableOf(result) : undefined,
        };
      }
      if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
        return callables.get(node.callee.name)?.result;
      }
      return undefined;
    }
    let loopDepth = 0;
    for (const p of f.params) {
      if (!t.isIdentifier(p) || bound.has(p.name)) {
        throw sourceError("Unsupported parameter");
      }
      if (apiNames.has(p.name)) {
        throw sourceError("Shadowed Effection import");
      }
      if (names.has(p.name)) {
        throw sourceError("Shadowed workflow function");
      }
      bound.add(p.name);
    }
    if (!t.isIdentifier(f.params[0], { name: "ctx" })) {
      throw sourceError("First parameter must be ctx");
    }
    function expr(n: Babel.types.Node | null | undefined, site: string): string {
      if (!n) {
        throw sourceError("Missing expression");
      }
      currentNode = n;
      if (t.isNullLiteral(n)) {
        return "(quote json-null)";
      }
      if (t.isStringLiteral(n)) {
        return schemeString(n.value);
      }
      if (t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isBooleanLiteral(n)) {
        return typeof n.value === "boolean" ? (n.value ? "#t" : "#f") : JSON.stringify(n.value);
      }
      if (t.isIdentifier(n)) {
        if (!bound.has(n.name) && !names.has(n.name)) {
          throw sourceError("Unbound local " + n.name);
        }
        return n.name;
      }
      if (entryInput && t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
        return `(json-field ${expr(n.object, site)} ${JSON.stringify(n.property.name)})`;
      }
      if (
        allowFinally &&
        t.isBinaryExpression(n) &&
        ["+", "-", "<", ">", "<=", ">=", "===", "!=="].includes(n.operator)
      ) {
        const operation =
          n.operator === "===" || n.operator === "!=="
            ? "="
            : n.operator === "+"
              ? "js-add"
              : n.operator;
        const value = `(${operation} ${expr(n.left, site)} ${expr(n.right, site)})`;
        return n.operator === "!==" ? `(not ${value})` : value;
      }
      if (allowFinally && t.isUnaryExpression(n, { operator: "!" })) {
        return `(not (truthy ${expr(n.argument, site)}))`;
      }
      if (
        allowFinally &&
        t.isAssignmentExpression(n) &&
        n.operator === "=" &&
        t.isIdentifier(n.left)
      ) {
        if (callables.has(n.left.name) || callableOf(n.right)) {
          throw sourceError("Callable bindings must be immutable");
        }
        if (!bound.has(n.left.name) || !mutable.has(n.left.name)) {
          throw sourceError("Assignment requires mutable local");
        }
        return `(set! ${n.left.name} ${expr(n.right, site)})`;
      }
      if (t.isObjectExpression(n)) {
        if (
          !n.properties.every(
            (p): p is Babel.types.ObjectProperty => t.isObjectProperty(p) && !p.computed,
          )
        ) {
          throw sourceError("Unsupported object property");
        }
        return `(object ${n.properties.map((p) => `(list ${schemeString(String(t.isIdentifier(p.key) ? p.key.name : "value" in p.key ? p.key.value : undefined))} ${expr(p.value, site)})`).join(" ")})`;
      }
      if (t.isArrayExpression(n)) {
        return `(list ${n.elements.map((e) => expr(e, site)).join(" ")})`;
      }
      if (allowFinally && (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n))) {
        if (n.async || (t.isFunctionExpression(n) && n.id)) {
          throw sourceError("Only anonymous synchronous workflow closures are supported");
        }
        validateCleanupPolicy(n, t);
        const saved = new Set(bound),
          savedMutable = new Set(mutable),
          savedCallables = new Map(callables),
          savedLoop = loopDepth;
        const params = new Set<string>();
        for (const parameter of n.params) {
          if (
            !t.isIdentifier(parameter) ||
            params.has(parameter.name) ||
            apiNames.has(parameter.name) ||
            names.has(parameter.name)
          ) {
            throw sourceError("Unsupported closure parameter");
          }
          params.add(parameter.name);
          bound.add(parameter.name);
          mutable.delete(parameter.name);
          callables.delete(parameter.name);
        }
        loopDepth = 0;
        const result = t.isBlockStatement(n.body)
          ? statements(n.body.body, `${site}/lambda`)
          : [`(workflow-return ${expr(n.body, `${site}/lambda/return`)})`];
        if (t.isBlockStatement(n.body) && !completes(n.body.body.at(-1))) {
          throw sourceError("Closure requires an explicit final return or throw");
        }
        loopDepth = savedLoop;
        bound.clear();
        saved.forEach((v) => bound.add(v));
        mutable.clear();
        savedMutable.forEach((v) => mutable.add(v));
        callables.clear();
        savedCallables.forEach((value, key) => callables.set(key, value));
        return `(lambda (${[...params].join(" ")}) ${result.join(" ")})`;
      }
      if (
        allowFinally &&
        t.isCallExpression(n) &&
        t.isIdentifier(n.callee) &&
        bound.has(n.callee.name) &&
        callables.get(n.callee.name)?.kind === "sync"
      ) {
        return `(${n.callee.name} ${n.arguments.map((a) => expr(a, site)).join(" ")})`;
      }
      if (t.isYieldExpression(n) && n.delegate && t.isCallExpression(n.argument)) {
        const call = n.argument,
          c = call.callee;
        if (
          t.isMemberExpression(c) &&
          !c.computed &&
          t.isIdentifier(c.object, { name: "ctx" }) &&
          t.isIdentifier(c.property, { name: "effect" })
        ) {
          const [reference, input] = call.arguments;
          const definition = t.isIdentifier(reference) && effectNames.get(reference.name);
          if (!definition || call.arguments.length !== 2) {
            throw sourceError("ctx.effect requires an installed effect and input");
          }
          if (sites[site]) {
            throw sourceError("Duplicate effect site");
          }
          sites[site] = {
            function: name,
            line: n.loc!.start.line,
            column: n.loc!.start.column,
            operation: "effect",
            name: definition.name,
            version: definition.version,
          };
          return `(yield-at ${JSON.stringify(site)} (list "effect" ${JSON.stringify(definition.name)} ${JSON.stringify(definition.version)} ${expr(input, site)}))`;
        }
        if (
          t.isMemberExpression(c) &&
          !c.computed &&
          t.isIdentifier(c.object, { name: "ctx" }) &&
          t.isIdentifier(c.property, { name: "elicit" })
        ) {
          if (sites[site]) {
            throw sourceError("Duplicate effect site");
          }
          sites[site] = {
            function: name,
            line: n.loc!.start.line,
            column: n.loc!.start.column,
            operation: "elicit",
            /* CONDITIONAL-SPREAD: Only a literal request site has a statically known key in emitted compiler metadata. */
            ...(t.isStringLiteral(call.arguments[0]) ? { key: call.arguments[0].value } : {}),
          };
          const args: Babel.types.Node[] = [...call.arguments];
          if (t.isObjectExpression(args[1])) {
            const properties = args[1].properties;
            if (
              properties.length !== 1 ||
              !t.isObjectProperty(properties[0]) ||
              properties[0].computed ||
              !t.isIdentifier(properties[0].key, { name: "message" })
            ) {
              throw sourceError("Compiled elicitation currently supports only { message }");
            }
            args[1] = properties[0].value;
          }
          return `(yield-at ${JSON.stringify(site)} (list "elicit" ${args.map((a) => expr(a, site)).join(" ")}))`;
        }
        if (t.isIdentifier(c) && scopeNames.has(c.name)) {
          const callback = call.arguments[0];
          if (
            call.arguments.length !== 1 ||
            !t.isFunctionExpression(callback) ||
            !callback.generator ||
            callback.async ||
            callback.params.length
          ) {
            throw sourceError("scoped requires a zero-argument generator callback");
          }
          validateCleanupPolicy(callback, t);
          if (!completes(callback.body.body.at(-1))) {
            throw sourceError("Scope callback requires an explicit final return or throw");
          }
          const saved = new Set(bound),
            savedMutable = new Set(mutable),
            savedLoop = loopDepth;
          loopDepth = 0;
          const body = statements(callback.body.body, `${site}/scope`);
          loopDepth = savedLoop;
          mutable.clear();
          savedMutable.forEach((v) => mutable.add(v));
          bound.clear();
          saved.forEach((v) => bound.add(v));
          sites[site] = {
            function: name,
            line: n.loc!.start.line,
            column: n.loc!.start.column,
            operation: "scoped",
          };
          return `(scope ${JSON.stringify(site)} (lambda () ${body.join(" ")}))`;
        }
        if (t.isIdentifier(c) && ensureNames.has(c.name)) {
          const callback = call.arguments[0];
          if (
            call.arguments.length !== 1 ||
            !t.isFunctionExpression(callback) ||
            !callback.generator ||
            callback.async ||
            callback.params.length
          ) {
            throw sourceError("ensure requires a zero-argument generator callback");
          }
          validateCleanupPolicy(callback, t);
          if (allowFinally) {
            const saved = new Set(bound),
              savedMutable = new Set(mutable),
              savedLoop = loopDepth;
            loopDepth = 0;
            const cleanup = statements(callback.body.body, `${site}/cleanup`);
            loopDepth = savedLoop;
            mutable.clear();
            savedMutable.forEach((v) => mutable.add(v));
            bound.clear();
            saved.forEach((v) => bound.add(v));
            return `(ensure (lambda () ${cleanup.join(" ")}))`;
          }
          const body = callback.body.body;
          if (!body.length || !body.every((s) => t.isExpressionStatement(s))) {
            throw sourceError("Cleanup supports effect statements only in this spike");
          }
          return `(ensure (lambda () ${body.map((s, i) => expr(s.expression, `${site}/cleanup-${i}`)).join(" ")}))`;
        }
        if (t.isIdentifier(c) && bound.has(c.name) && callables.get(c.name)?.kind === "generator") {
          return `(${c.name} ${call.arguments.map((a) => expr(a, site)).join(" ")})`;
        }
        if (t.isIdentifier(c) && names.has(c.name)) {
          const target = functions.find((f) => f.id!.name === c.name);
          if (call.arguments.length !== target!.params.length) {
            throw sourceError("Helper arity mismatch");
          }
          return `(${c.name} ${call.arguments.map((a) => expr(a, site)).join(" ")})`;
        }
      }
      throw sourceError("Unsupported expression " + n.type);
    }
    function statements(xs: Babel.types.Statement[], path: string): string[] {
      const body: string[] = [];
      for (const [i, s] of xs.entries()) {
        currentNode = s;
        const site = `${path}/statement-${i}`;
        if (
          t.isVariableDeclaration(s) &&
          (s.kind === "const" || (allowFinally && s.kind === "let")) &&
          s.declarations.length === 1
        ) {
          const d = s.declarations[0];
          if (
            !t.isIdentifier(d.id) ||
            bound.has(d.id.name) ||
            apiNames.has(d.id.name) ||
            names.has(d.id.name)
          ) {
            throw sourceError("Unsupported binding");
          }
          const callable = callableOf(d.init);
          if (callable && s.kind !== "const") {
            throw sourceError("Callable bindings must be immutable");
          }
          const value = expr(d.init, `${path}/${d.id.name}`);
          if (callable) {
            callables.set(d.id.name, callable);
          } else {
            callables.delete(d.id.name);
          }
          bound.add(d.id.name);
          if (s.kind === "let") {
            mutable.add(d.id.name);
          } else {
            mutable.delete(d.id.name);
          }
          body.push(`(define ${d.id.name} ${value})`);
        } else if (allowFinally && t.isWhileStatement(s)) {
          const before = new Set(bound),
            beforeMutable = new Set(mutable);
          loopDepth++;
          const inner = statements(
            t.isBlockStatement(s.body) ? s.body.body : [s.body],
            `${site}/loop`,
          );
          loopDepth--;
          bound.clear();
          before.forEach((v) => bound.add(v));
          mutable.clear();
          beforeMutable.forEach((v) => mutable.add(v));
          body.push(`(while (truthy ${expr(s.test, site)}) (block ${inner.join(" ")}))`);
        } else if (allowFinally && t.isIfStatement(s)) {
          const branch = (node: Babel.types.Statement | null | undefined) => {
            const before = new Set(bound),
              beforeMutable = new Set(mutable);
            const result = statements(
              node ? (t.isBlockStatement(node) ? node.body : [node]) : [],
              `${site}/${node === s.consequent ? "then" : "else"}`,
            );
            bound.clear();
            before.forEach((v) => bound.add(v));
            mutable.clear();
            beforeMutable.forEach((v) => mutable.add(v));
            return `(block ${result.join(" ")})`;
          };
          body.push(
            `(if (truthy ${expr(s.test, site)}) ${branch(s.consequent)} ${branch(s.alternate)})`,
          );
        } else if (allowFinally && (t.isBreakStatement(s) || t.isContinueStatement(s))) {
          if (!loopDepth || s.label) {
            throw sourceError("Only unlabeled loop exits supported");
          }
          body.push(t.isBreakStatement(s) ? "(break)" : "(continue)");
        } else if ((allowEnsure || allowFinally) && t.isExpressionStatement(s)) {
          body.push(expr(s.expression, site));
        } else if (allowFinally && t.isTryStatement(s)) {
          if (s.handler || !s.finalizer) {
            throw sourceError("Only try/finally supported");
          }
          const before = new Set(bound),
            beforeMutable = new Set(mutable);
          const main = statements(s.block.body, `${site}/try`);
          bound.clear();
          before.forEach((v) => bound.add(v));
          mutable.clear();
          beforeMutable.forEach((v) => mutable.add(v));
          const cleanup = statements(s.finalizer.body, `${site}/finally`);
          bound.clear();
          before.forEach((v) => bound.add(v));
          mutable.clear();
          beforeMutable.forEach((v) => mutable.add(v));
          body.push(`(try-finally (block ${main.join(" ")}) (block ${cleanup.join(" ")}))`);
        } else if (allowFinally && t.isThrowStatement(s)) {
          body.push(`(workflow-throw ${expr(s.argument, site)})`);
        } else if (t.isReturnStatement(s) && (allowFinally || i === xs.length - 1)) {
          const value = expr(s.argument, `${path}/return`);
          body.push(allowFinally ? `(workflow-return ${value})` : value);
        } else {
          throw sourceError("Unsupported statement " + s.type);
        }
      }
      return body;
    }
    const body = statements(f.body.body, name);
    function completes(s: Babel.types.Statement | undefined): boolean {
      return (
        t.isReturnStatement(s) ||
        t.isThrowStatement(s) ||
        (t.isTryStatement(s) && !s.handler && completes(s.block.body.at(-1)))
      );
    }
    if (allowFinally ? !completes(f.body.body.at(-1)) : !t.isReturnStatement(f.body.body.at(-1))) {
      throw sourceError("Explicit final return or throw required");
    }
    locations[name] = { line: f.loc!.start.line, column: f.loc!.start.column };
    return `(define (${name} ${f.params.map((p) => (p as Babel.types.Identifier).name).join(" ")}) ${body.join(" ")})`;
  }
  if (entryPoint !== null && !names.has(entryPoint)) {
    throw sourceError("Unknown entry point");
  }
  const scheme =
    functions.map(emitFunction).join("\n") +
    (entryPoint === null ? "\n" : `\n(${entryPoint} #f${entryInput ? " %input" : ""})\n`);
  return { scheme, debug: { sites, locations } };
}
