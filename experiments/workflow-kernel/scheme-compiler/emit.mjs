// Compile the supported developer generator subset to workflow Scheme and source metadata.
import { createRequire } from "node:module";
import { validateCleanupPolicy } from "../compiler-shared/cleanup-policy.mjs";
const babel = createRequire(new URL("../../../packages/vite-plugin/package.json", import.meta.url))(
  "@babel/core",
);
import { schemeString } from "../scheme-data/values.mjs";
const t = babel.types;
export function emitWorkflowScheme(
  source,
  {
    allowEnsure = false,
    allowFinally = false,
    allowScopes = false,
    entryInput = false,
    entryPoint = "workflow",
    installedEffects = [],
  } = {},
) {
  const ast = babel.parseSync(source, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  const imports = ast.program.body.filter((n) => t.isImportDeclaration(n));
  if (allowScopes && !allowFinally) {
    throw Error("Scopes require the explicit unwind backend");
  }
  const ensureNames = new Set(),
    scopeNames = new Set(),
    apiNames = new Set();
  const effectNames = new Map();
  for (const imp of imports) {
    const bindings = installedEffects.filter((binding) => binding.module === imp.source.value);
    if (bindings.length) {
      for (const spec of imp.specifiers) {
        const binding =
          t.isImportSpecifier(spec) && bindings.find((b) => b.export === spec.imported.name);
        if (!binding || effectNames.has(spec.local.name)) {
          throw Error("Unknown installed effect import");
        }
        if (!binding.definition?.name || !binding.definition?.version) {
          throw Error("Invalid installed effect binding");
        }
        effectNames.set(spec.local.name, binding.definition);
        apiNames.add(spec.local.name);
      }
      continue;
    }
    if ((!allowEnsure && !allowScopes) || imp.source.value !== "effection") {
      throw Error("Unsupported import");
    }
    for (const spec of imp.specifiers) {
      if (spec.importKind === "type") {
        continue;
      }
      if (!t.isImportSpecifier(spec)) {
        throw Error("Unsupported import");
      }
      if (spec.imported.name === "ensure" && allowEnsure) {
        ensureNames.add(spec.local.name);
      } else if (spec.imported.name === "scoped" && allowScopes) {
        scopeNames.add(spec.local.name);
      } else {
        throw Error("Unsupported import");
      }
      apiNames.add(spec.local.name);
    }
  }
  const functions = ast.program.body.filter((n) => !t.isImportDeclaration(n));
  const names = new Set();
  for (const f of functions) {
    if (
      !t.isFunctionDeclaration(f) ||
      !f.generator ||
      f.async ||
      !f.body.directives.some((d) => d.value.value === "use workflow")
    ) {
      throw Error("Expected named function* with use workflow directive");
    }
    validateCleanupPolicy(f, t);
    if (apiNames.has(f.id.name)) {
      throw Error("Shadowed Effection import");
    }
    if (names.has(f.id.name)) {
      throw Error("Duplicate function");
    }
    names.add(f.id.name);
  }
  const sites = {},
    locations = {};
  function emitFunction(f) {
    const name = f.id.name,
      bound = new Set(),
      mutable = new Set();
    let loopDepth = 0;
    for (const p of f.params) {
      if (!t.isIdentifier(p) || bound.has(p.name)) {
        throw Error("Unsupported parameter");
      }
      if (apiNames.has(p.name)) {
        throw Error("Shadowed Effection import");
      }
      if (names.has(p.name)) {
        throw Error("Shadowed workflow function");
      }
      bound.add(p.name);
    }
    if (f.params[0]?.name !== "ctx") {
      throw Error("First parameter must be ctx");
    }
    function expr(n, site) {
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
        if (!bound.has(n.name)) {
          throw Error("Unbound local " + n.name);
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
      if (
        allowFinally &&
        t.isAssignmentExpression(n) &&
        n.operator === "=" &&
        t.isIdentifier(n.left)
      ) {
        if (!bound.has(n.left.name) || !mutable.has(n.left.name)) {
          throw Error("Assignment requires mutable local");
        }
        return `(set! ${n.left.name} ${expr(n.right, site)})`;
      }
      if (t.isObjectExpression(n)) {
        if (n.properties.some((p) => !t.isObjectProperty(p) || p.computed)) {
          throw Error("Unsupported object property");
        }
        return `(object ${n.properties.map((p) => `(list ${schemeString(String(p.key.name ?? p.key.value))} ${expr(p.value, site)})`).join(" ")})`;
      }
      if (t.isArrayExpression(n)) {
        return `(list ${n.elements.map((e) => expr(e, site)).join(" ")})`;
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
            throw Error("ctx.effect requires an installed effect and input");
          }
          if (sites[site]) {
            throw Error("Duplicate effect site");
          }
          sites[site] = {
            function: name,
            line: n.loc.start.line,
            column: n.loc.start.column,
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
            throw Error("Duplicate effect site");
          }
          sites[site] = {
            function: name,
            line: n.loc.start.line,
            column: n.loc.start.column,
            operation: "elicit",
            /* CONDITIONAL-SPREAD: Only a literal request site has a statically known key in emitted compiler metadata. */
            ...(t.isStringLiteral(call.arguments[0]) ? { key: call.arguments[0].value } : {}),
          };
          const args = [...call.arguments];
          if (t.isObjectExpression(args[1])) {
            const properties = args[1].properties;
            if (
              properties.length !== 1 ||
              !t.isObjectProperty(properties[0]) ||
              properties[0].computed ||
              !t.isIdentifier(properties[0].key, { name: "message" })
            ) {
              throw Error("Compiled elicitation currently supports only { message }");
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
            throw Error("scoped requires a zero-argument generator callback");
          }
          validateCleanupPolicy(callback, t);
          if (!completes(callback.body.body.at(-1))) {
            throw Error("Scope callback requires an explicit final return or throw");
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
            line: n.loc.start.line,
            column: n.loc.start.column,
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
            throw Error("ensure requires a zero-argument generator callback");
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
          if (!body.length || body.some((s) => !t.isExpressionStatement(s))) {
            throw Error("Cleanup supports effect statements only in this spike");
          }
          return `(ensure (lambda () ${body.map((s, i) => expr(s.expression, `${site}/cleanup-${i}`)).join(" ")}))`;
        }
        if (t.isIdentifier(c) && names.has(c.name)) {
          const target = functions.find((f) => f.id.name === c.name);
          if (call.arguments.length !== target.params.length) {
            throw Error("Helper arity mismatch");
          }
          return `(${c.name} ${call.arguments.map((a) => expr(a, site)).join(" ")})`;
        }
      }
      throw Error("Unsupported expression " + n.type);
    }
    function statements(xs, path) {
      const body = [];
      for (const [i, s] of xs.entries()) {
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
            throw Error("Unsupported binding");
          }
          const value = expr(d.init, `${path}/${d.id.name}`);
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
          const branch = (node) => {
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
            throw Error("Only unlabeled loop exits supported");
          }
          body.push(t.isBreakStatement(s) ? "(break)" : "(continue)");
        } else if ((allowEnsure || allowFinally) && t.isExpressionStatement(s)) {
          body.push(expr(s.expression, site));
        } else if (allowFinally && t.isTryStatement(s)) {
          if (s.handler || !s.finalizer) {
            throw Error("Only try/finally supported");
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
          throw Error("Unsupported statement " + s.type);
        }
      }
      return body;
    }
    const body = statements(f.body.body, name);
    function completes(s) {
      return (
        t.isReturnStatement(s) ||
        t.isThrowStatement(s) ||
        (t.isTryStatement(s) && !s.handler && completes(s.block.body.at(-1)))
      );
    }
    if (allowFinally ? !completes(f.body.body.at(-1)) : !t.isReturnStatement(f.body.body.at(-1))) {
      throw Error("Explicit final return or throw required");
    }
    locations[name] = { line: f.loc.start.line, column: f.loc.start.column };
    return `(define (${name} ${f.params.map((p) => p.name).join(" ")}) ${body.join(" ")})`;
  }
  if (entryPoint !== null && !names.has(entryPoint)) {
    throw Error("Unknown entry point");
  }
  const scheme =
    functions.map(emitFunction).join("\n") +
    (entryPoint === null ? "\n" : `\n(${entryPoint} #f${entryInput ? " %input" : ""})\n`);
  return { scheme, debug: { sites, locations } };
}
