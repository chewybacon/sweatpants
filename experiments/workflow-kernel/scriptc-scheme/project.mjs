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
  const entry = module.functions.find((f) => f.name === "review");
  const outcomeUnion = module.unions?.find((u) => u.id === entry?.generator?.nextT.unionId);
  if (outcomeUnion) {
    const expected = [
      { tag: 0, values: [true] },
      { tag: 1, values: [false] },
    ];
    if (
      outcomeUnion.arms.length !== 2 ||
      outcomeUnion.discriminant?.field !== "ok" ||
      JSON.stringify(outcomeUnion.discriminant.cases) !== JSON.stringify(expected) ||
      outcomeUnion.arms.some((arm, index) => {
        const record = module.records.find((r) => r.id === arm.shapeId);
        return (
          arm.kind !== "record" ||
          record?.fields.length !== 2 ||
          !record.fields.some((f) => f.name === "ok" && f.type.kind === "bool") ||
          !record.fields.some(
            (f) => f.name === (index === 0 ? "value" : "error") && f.type.kind === "string",
          )
        );
      })
    ) {
      throw new Error("Unsupported Outcome union profile");
    }
  }
  const type = (t) => {
    if (t.kind === "string") {
      return { kind: "string" };
    }
    if (t.kind === "union" && t.unionId === outcomeUnion?.id) {
      return { kind: "json" };
    }
    if (t.kind === "bool") {
      return { kind: "boolean" };
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
        case "unionDisc":
          if (e.unionId !== outcomeUnion?.id || e.field !== "ok") {
            return refuse(e);
          }
          return { kind: "json-field", object: expr(e.value), key: "ok", origin: o };
        case "unionNarrow":
          if (e.unionId !== outcomeUnion?.id || ![0, 1].includes(e.tag)) {
            return refuse(e);
          }
          return expr(e.value);
        case "recordGet":
          if (
            !outcomeUnion?.arms.some((arm) => arm.shapeId === e.shapeId) ||
            !["value", "error"].includes(e.field)
          ) {
            return refuse(e);
          }
          return { kind: "json-field", object: expr(e.obj), key: e.field, origin: o };
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
          if (admitted && !admitted.unwrap) {
            return { kind: "yield-at", site, request: expr(e.value), origin: o };
          }
          // This bounded authoring API promises a value or throw. Make that
          // convenience explicit in the program, not in the host reply convention.
          const reply = {
            id: `reply-${serial++}`,
            name: `reply-${serial++}`,
            type: { kind: "json" },
            mutable: false,
          };
          const unwrapId = `unwrap-${serial++}`;
          const field = (key) => ({
            kind: "json-field",
            object: { kind: "read", binding: reply, origin: o },
            key,
            origin: o,
          });
          const unwrap = {
            id: unwrapId,
            name: `unwrap-${serial++}`,
            kind: "sync",
            parameters: [reply],
            result: { kind: "string" },
            captures: [],
            scope: `scope-${serial++}`,
            origin: o,
            body: {
              exit: "fallthrough",
              statements: [
                {
                  kind: "if",
                  test: { kind: "not", value: field("ok"), origin: o },
                  consequent: {
                    exit: "fallthrough",
                    statements: [{ kind: "workflow-throw", value: field("error"), origin: o }],
                  },
                  otherwise: { exit: "fallthrough", statements: [] },
                  origin: o,
                },
                { kind: "tail-value", target: unwrapId, value: field("value"), origin: o },
              ],
            },
          };
          return {
            kind: "apply",
            callable: "sync",
            callee: { kind: "lambda", fn: unwrap, origin: o },
            args: [{ kind: "yield-at", site, request: expr(e.value), origin: o }],
            origin: o,
          };
        }
        default:
          return refuse(e);
      }
    }
    const block = (stmts) => ({ statements: stmts.map(stmt), exit: "fallthrough" });
    function stmt(s) {
      const o = origin(s.loc);
      switch (s.kind) {
        case "if":
          if (s.cond.type.kind !== "bool") {
            return refuse(s);
          }
          return {
            kind: "if",
            test: expr(s.cond),
            consequent: block(s.then),
            otherwise: block(s.else_ ?? []),
            origin: o,
          };
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
  if (
    !entry?.generator ||
    (options.sites
      ? entry.generator.yieldT.kind !== "array"
      : entry.generator.yieldT.kind !== "string") ||
    (entry.generator.nextT.kind !== "string" && !outcomeUnion)
  ) {
    throw new Error("Expected string review generator");
  }
  const program = { functions: [lower(entry)], debug, entryPoint: null, entryInput: false };
  return emitSchemeIR(program);
}
