import { emitSchemeIR } from "../../../packages/flowmode-compiler/src/emit-scheme.ts";

// Experimental projection of the recorded frontend output. No ScriptC runtime
// intrinsic, module initializer, generator object, or host ABI is executed.
export function project(module, text, options = {}) {
  const debug = { sites: {}, locations: {} };
  let serial = 0;
  const origin = (loc) => {
    const lines = (options.sources?.[loc.file] ?? text).slice(0, loc.start).split("\n");
    return { sourceId: loc.file, line: lines.length, column: lines.at(-1).length + 1 };
  };
  const refuse = (node) => {
    throw new Error(`Unsupported ScriptC projection: ${node.kind ?? node.name}`);
  };
  const type = (t) => {
    if (t.kind === "string") {
      return { kind: "string" };
    }
    if (t.kind === "func") {
      return {
        kind: "callable",
        callable: "sync",
        parameters: t.params.map(type),
        result: type(t.ret),
      };
    }
    return refuse(t);
  };
  function lower(fn, captures = []) {
    if (fn.async || fn.classCaptures || (fn.captures?.length ?? 0) !== captures.length) {
      return refuse(fn);
    }
    const id = `function-${serial++}`;
    const env = new Map((fn.captures ?? []).map((c, i) => [c.localId, captures[i]]));
    for (const local of fn.locals) {
      if (!env.has(local.id)) {
        env.set(local.id, {
          id: `binding-${serial++}`,
          name: `local-${serial}`,
          type: type(local.type),
          mutable: local.mutable,
        });
      }
    }
    const binding = (key) => {
      if (!env.has(key)) {
        throw new Error(`Unknown ScriptC local ${key}`);
      }
      return env.get(key);
    };
    function expr(e) {
      const o = origin(e.loc);
      switch (e.kind) {
        case "arrayLit":
          return { kind: "list", values: e.elems.map(expr), origin: o };
        case "call": {
          const target = module.functions.find((f) => f.name === e.callee);
          if (
            !options.helpers?.includes(e.callee) ||
            !target ||
            target.generator ||
            target.captures?.length
          ) {
            return refuse(e);
          }
          return {
            kind: "apply",
            callable: "sync",
            callee: { kind: "lambda", fn: lower(target), origin: o },
            args: e.args.map(expr),
            origin: o,
          };
        }
        case "strLit":
          return { kind: "literal", value: e.value, origin: o };
        case "varRef":
          return { kind: "read", binding: binding(e.localId), origin: o };
        case "strConcat":
          return { kind: "js-add", left: expr(e.left), right: expr(e.right), origin: o };
        case "closure": {
          if (e.adapts) {
            return refuse(e);
          }
          const target = module.functions.find((f) => f.name === e.fnName);
          if (!target || target.generator) {
            return refuse(e);
          }
          return { kind: "lambda", fn: lower(target, e.captures.map(binding)), origin: o };
        }
        case "callValue": {
          if (e.receiver || e.callee.type.kind !== "func") {
            return refuse(e);
          }
          return {
            kind: "apply",
            callable: "sync",
            callee: expr(e.callee),
            args: e.args.map(expr),
            origin: o,
          };
        }
        case "yieldExpr": {
          if (!fn.generator || e.awaited || e.delegated || e.captureCompletion || !e.value) {
            return refuse(e);
          }
          const admitted = options.sites?.[e.loc.start];
          if (options.sites && (!admitted || e.loc.file !== "review.ts")) {
            return refuse(e);
          }
          const site = `scriptc:${admitted?.start ?? e.loc.start}`;
          debug.sites[site] = { ...(admitted ?? o), function: fn.name, operation: "effect" };
          return { kind: "yield-at", site, request: expr(e.value), origin: o };
        }
        default:
          return refuse(e);
      }
    }
    const block = (stmts) => ({ statements: stmts.map(stmt), exit: "fallthrough" });
    function stmt(s) {
      const o = origin(s.loc);
      switch (s.kind) {
        case "varDecl":
          return { kind: "define", binding: binding(s.localId), value: expr(s.init), origin: o };
        case "assign":
          return {
            kind: "expression",
            value: { kind: "set!", binding: binding(s.localId), value: expr(s.value), origin: o },
            origin: o,
          };
        case "exprStmt":
          return { kind: "expression", value: expr(s.expr), origin: o };
        case "return":
          return {
            kind: fn.generator ? "workflow-return" : "tail-value",
            target: id,
            value: expr(s.value),
            origin: o,
          };
        case "tryCatch": {
          if (s.catchBody || !s.finallyBody || s.suppressFinallyErrors || s.dropFinallyErrors) {
            return refuse(s);
          }
          return {
            kind: "try-finally",
            body: block(s.tryBody),
            cleanup: block(s.finallyBody),
            origin: o,
          };
        }
        case "runtimeFence": {
          // Preserve the compiler's unreachable-path trap, never erase it.
          if (s.code !== "SC9002") {
            return refuse(s);
          }
          return {
            kind: "workflow-throw",
            value: { kind: "literal", value: s.message, origin: o },
            origin: o,
          };
        }
        default:
          return refuse(s);
      }
    }
    // A sync return is only a tail value for this deliberately bounded subset.
    if (!fn.generator && (fn.body.length !== 1 || fn.body[0].kind !== "return")) {
      return refuse(fn);
    }
    return {
      id,
      name: fn.name === "review" ? "review" : `closure-${serial++}`,
      kind: fn.generator ? "workflow" : "sync",
      parameters: fn.params.map((p) => binding(p.localId)),
      result: type(fn.returnType),
      captures,
      scope: `scope-${serial++}`,
      body: block(fn.body),
      origin: origin(fn.loc),
    };
  }
  const entry = module.functions.find((f) => f.name === "review");
  if (
    !entry?.generator ||
    (options.sites
      ? entry.generator.yieldT.kind !== "array"
      : entry.generator.yieldT.kind !== "string") ||
    entry.generator.nextT.kind !== "string"
  ) {
    throw new Error("Expected string review generator");
  }
  const program = { functions: [lower(entry)], debug, entryPoint: null, entryInput: false };
  return emitSchemeIR(program);
}
