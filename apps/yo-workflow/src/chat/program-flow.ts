import { isEvalNode, isFnNode, isQuoteNode, isRefNode, print, type TisynExpr } from "@tisyn/ir";
import { parseTisynAuthoring, parseTisynSource } from "../workflow/source.ts";
export interface FlowNode {
  id: string;
  kind: "yield" | "branch" | "exit" | "call" | "entry";
  title: string;
  detail: string;
  caption?: string;
  origin?: "builtin" | "authored";
}
export interface FlowEdge {
  source: string;
  target: string;
  label?: string;
}
type Target = { id: string; label?: string };
type Func = { id: number; params: string[]; body: TisynExpr };
type Env = Map<string, Func | null>;
const fields = (x: TisynExpr | undefined): Record<string, TisynExpr> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, TisynExpr>) : {};
const payload = (x: TisynExpr) => (isQuoteNode(x) ? x.expr : x);
const short = (s: string) => (s.length > 65 ? s.slice(0, 64) + "…" : s);
function describe(x: TisynExpr): string {
  if (x === undefined) return "value";
  if (isRefNode(x)) return x.name;
  if (isEvalNode(x)) {
    const d = fields(payload(x.data));
    if (x.id === "get")
      return describe(d.obj) + "." + (typeof d.key === "string" ? d.key : describe(d.key));
    const ops: Record<string, string> = {
      eq: "=",
      neq: "≠",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
      add: "+",
      sub: "−",
      and: "and",
      or: "or",
    };
    if (ops[x.id]) return "(" + describe(d.a) + " " + ops[x.id] + " " + describe(d.b) + ")";
    if (x.id === "construct")
      return typeof d.reason === "string"
        ? d.reason
        : typeof d.status === "string"
          ? d.status
          : "result";
  }
  return short(print(x, { compact: true }));
}
const pure = new Set([
  "if",
  "__tisyn_switch",
  "get",
  "construct",
  "array",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "not",
  "and",
  "or",
  "concat",
  "concat-arrays",
  "merge-objects",
]);
function isPure(x: TisynExpr): boolean {
  if (isQuoteNode(x) || isFnNode(x) || isRefNode(x)) return true;
  if (isEvalNode(x))
    return (
      (pure.has(x.id) || x.id.startsWith("__json_") || x.id.startsWith("__schema_")) &&
      isPure(payload(x.data))
    );
  return !x || typeof x !== "object" || Object.values(x).every((v) => isPure(v as TisynExpr));
}
/** Continuation-passing static projection. Never evaluates code or consumes journal state. */
export function createProgramFlow(source: string) {
  const expanded = parseTisynSource(source),
    ir = parseTisynAuthoring(source);
  let nodes: FlowNode[] = [],
    edges: FlowEdge[] = [],
    visits = 0,
    truncated = false;
  const functions = new Map<TisynExpr, Func>(),
    invocations = new Map<string, Target>(),
    active = new Set<number>();
  function node(
    kind: FlowNode["kind"],
    title: string,
    detail = "",
    caption?: string,
    origin?: FlowNode["origin"],
  ): Target {
    const id = "flow-" + nodes.length;
    nodes.push({ id, kind, title, detail, caption, origin });
    return { id };
  }
  function edge(from: Target, to: Target, label?: string) {
    edges.push({
      source: from.id,
      target: to.id,
      label: label ?? to.label,
    });
  }
  function resolve(x: TisynExpr, env: Env): Func | undefined {
    if (isRefNode(x)) return env.get(x.name) ?? undefined;
    if (!isFnNode(x)) return undefined;
    let fn = functions.get(x);
    if (!fn) {
      fn = { id: functions.size, params: [...x.params], body: x.body };
      functions.set(x, fn);
    }
    return fn;
  }
  function finish(x: TisynExpr, k: Target | null): Target {
    return (
      k ?? node("exit", "Return " + describe(x).replaceAll("_", " "), print(x, { compact: true }))
    );
  }
  function invoke(fn: Func, args: TisynExpr[], env: Env, k: Target | null, name: string): Target {
    const scope = new Map(env);
    fn.params.forEach((p, i) => scope.set(p, resolve(args[i], env) ?? null));
    // Kernel functions use caller scope. Function-valued bindings distinguish
    // specializations; unknown values shadow names rather than resolving globally.
    const bindings = [...scope]
      .filter(([, v]) => v)
      .map(([n, v]) => [n, v!.id])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const key = JSON.stringify([fn.id, bindings, k]);
    const known = invocations.get(key);
    if (known) return known;
    if (active.has(fn.id)) {
      const call = node(
        "call",
        "Call " + name,
        print(fn.body),
        "Recursive call with a different continuation",
      );
      if (k) edge(call, k);
      return call;
    }
    const anchor = node("entry", name, name + "(" + fn.params.join(", ") + ")");
    invocations.set(key, anchor);
    active.add(fn.id);
    edge(anchor, compile(fn.body, scope, k));
    active.delete(fn.id);
    return anchor;
  }
  function bindings(entries: TisynExpr[][], body: TisynExpr, env: Env, k: Target | null): Target {
    if (!entries.length) return compile(body, env, k);
    const [first, ...rest] = entries,
      name = String(first[0]),
      value = first[1];
    const scope = new Map(env);
    scope.set(name, resolve(value, env) ?? null);
    const after = bindings(rest, body, scope, k);
    if (isFnNode(value)) return after;
    if (isPure(value)) return after;
    return compile(value, env, after);
  }
  function compile(x: TisynExpr, env: Env, k: Target | null): Target {
    if (++visits > 400) {
      truncated = true;
      return node("call", "See source", "Static projection limit reached");
    }
    if (isPure(x)) return finish(x, k);
    if (!isEvalNode(x)) return opaque(x, k);
    const d = fields(payload(x.data)),
      a = Array.isArray(x.data) ? x.data : [];
    if (x.id === "let") return bindings([[d.name, d.value]], d.body, env, k);
    if (x.id === "__collection_bindings") return bindings(a[0] as TisynExpr[][], a[1], env, k);
    if (x.id === "seq") {
      const exprs = Array.isArray(d.exprs) ? d.exprs : [];
      let target = k;
      for (let i = exprs.length - 1; i >= 0; i--) target = compile(exprs[i], env, target);
      return target ?? finish(null, k);
    }
    if (x.id === "if" || x.id === "__tisyn_switch") {
      const condition = x.id === "if" ? d.condition : a[0];
      const comparison =
        isEvalNode(condition) && condition.id === "eq"
          ? fields(payload(condition.data))
          : undefined;
      const namedOutcome =
        comparison && typeof comparison.b === "string" ? comparison.b : undefined;
      const branch = node(
        "branch",
        namedOutcome ? describe(comparison!.a) : describe(condition),
        print(condition),
      );
      if (x.id === "if") {
        edge(branch, compile(d.then, env, k), namedOutcome ?? "yes");
        edge(branch, compile(d.else ?? null, env, k), namedOutcome ? "not " + namedOutcome : "no");
      } else {
        Object.entries(fields(a[1])).forEach(([label, body]) =>
          edge(branch, compile(body, env, k), label),
        );
        edge(branch, compile(a[2], env, k), "otherwise");
      }
      return isPure(condition) ? branch : compile(condition, env, branch);
    }
    if (x.id === "__exchange_accepted" || x.id === "__exchange_parsed") {
      const branch = node(
        "branch",
        x.id === "__exchange_accepted" ? "Reply outcome" : "Sample outcome",
      );
      const labels =
        x.id === "__exchange_accepted"
          ? ["accepted", "declined / cancelled"]
          : ["valid", "invalid"];
      labels.forEach((label, i) => {
        const fn = resolve(a[i + 1], env);
        edge(branch, fn ? invoke(fn, [], env, k, "Continuation") : opaque(a[i + 1], k), label);
      });
      return compile(a[0], env, branch);
    }
    if (x.id === "call") {
      const args = Array.isArray(d.args) ? d.args : [];
      if (!args.every(isPure) || !isPure(d.fn)) return opaque(x, k);
      const fn = resolve(d.fn, env);
      if (fn) {
        return invoke(fn, args, env, k, describe(d.fn));
      }
      const call = node("call", "Call " + describe(d.fn), print(x), "Target determined at runtime");
      if (k) edge(call, k);
      return call;
    }
    if (["__collection_map", "__collection_filter", "__collection_reduce"].includes(x.id)) {
      const fn = resolve(a[a.length - 1], env);
      if (!fn || !a.slice(0, -1).every(isPure)) return opaque(x, k);
      if (isPure(fn.body)) return finish(x, k);
      const loop = node("branch", "For each item", print(x), describe(a[0]));
      const body = invoke(fn, [], env, { id: loop.id, label: "next item" }, "Collection callback");
      edge(loop, body, "item");
      edge(loop, k ?? node("exit", "Return collection result"), "complete");
      return loop;
    }
    if (x.id === "while") {
      if (!isPure(d.condition)) return opaque(x, k);
      const loop = node("branch", "While " + describe(d.condition), print(d.condition));
      const body = Array.isArray(d.exprs) ? d.exprs : [];
      let back: Target = { id: loop.id, label: "repeat" };
      for (let i = body.length - 1; i >= 0; i--) back = compile(body[i], env, back);
      edge(loop, back, "yes");
      edge(loop, k ?? node("exit", "Return loop result"), "no");
      return loop;
    }
    if (x.id === "throw") return node("exit", "Fail", print(x));
    // Only known host bindings are tools. An unknown Eval may be an unsupported
    // kernel operation, so its provenance must remain unspecified.
    const effects: Record<string, [string, NonNullable<FlowNode["origin"]>]> = {
      __exchange_ask: ["Ask", "authored"],
      __exchange_sample: ["Sample", "builtin"],
      __tisyn_classify: ["Classify", "builtin"],
      sample: ["Sample", "builtin"],
      __tisyn_random: ["Random", "builtin"],
      random: ["Random", "builtin"],
      decision: ["Decision", "builtin"],
      ask: ["Ask", "authored"],
      echo: ["Echo", "authored"],
      document_create: ["Create document", "authored"],
      document_read: ["Read document", "authored"],
      document_edit: ["Edit document", "authored"],
      present_choices: ["Present choices", "authored"],
      display_document: ["Display document", "authored"],
      session: ["Session", "authored"],
    };
    if (effects[x.id]) {
      const request = a[0] ?? x.data;
      if (!isPure(request)) return opaque(x, k);
      const input = fields(
        isEvalNode(request) && request.id === "construct" ? payload(request.data) : request,
      );
      const hint = input.title ?? input.prompt ?? input.instructions ?? input.message;
      const effect = node(
        "yield",
        effects[x.id][0],
        print(request),
        typeof hint === "string" ? hint : hint ? describe(hint) : undefined,
        effects[x.id][1],
      );
      edge(effect, k ?? node("exit", "Return result"));
      return effect;
    }
    return opaque(x, k);
  }
  function opaque(x: TisynExpr, k: Target | null): Target {
    const n = node(
      "call",
      isEvalNode(x) ? "Operation " + x.id : "Computed operation",
      print(x),
      "Unexpanded control or effect — see source",
    );
    if (k) edge(n, k);
    return n;
  }
  const entry = node("entry", "Start");
  edge(entry, compile(ir, new Map(), null));
  // Remove function-entry plumbing without expanding recursion again.
  for (const n of [...nodes]) {
    if (n.kind !== "entry" || n.id === entry.id) continue;
    const outgoing = edges.filter((e) => e.source === n.id);
    if (outgoing.length !== 1 || outgoing[0].target === n.id) continue;
    const out = outgoing[0];
    edges = edges
      .filter((e) => e.source !== n.id)
      .map((e) =>
        e.target === n.id
          ? {
              ...e,
              target: out.target,
              label: e.label ?? out.label,
            }
          : e,
      );
    nodes = nodes.filter((x) => x.id !== n.id);
  }
  // A branch directly after a yield becomes labeled resume paths.
  for (const n of [...nodes]) {
    if (n.kind !== "branch") continue;
    const incoming = edges.filter((e) => e.target === n.id);
    if (incoming.length !== 1) continue;
    const from = nodes.find((x) => x.id === incoming[0].source);
    if (from?.kind !== "yield" || edges.filter((e) => e.source === from.id).length !== 1) continue;
    const outgoing = edges.filter((e) => e.source === n.id);
    const generic = n.title === "Reply outcome" || n.title === "Sample outcome";
    // A yes/no edge still needs its condition node to explain the choice.
    if (!generic && outgoing.some((e) => e.label === "yes" || e.label === "no")) continue;
    edges = edges.filter((e) => e.target !== n.id && e.source !== n.id);
    outgoing.forEach((e) =>
      edges.push({
        ...e,
        source: from.id,
        label: e.label,
      }),
    );
    nodes = nodes.filter((x) => x.id !== n.id);
  }
  // Terminal nodes represent the end of execution, not equality of return values.
  // Preserve each return expression in the shared endpoint's source tooltip.
  // Failures remain separate from normal completion.
  for (const failure of [false, true]) {
    const exits = nodes.filter((n) => n.kind === "exit" && (n.title === "Fail") === failure);
    if (!exits.length) continue;
    const [endpoint, ...rest] = exits;
    const removed = new Set(rest.map((n) => n.id));
    const descriptions = [...new Set(exits.map((n) => n.detail || n.title))];
    endpoint.title = failure ? "Fail" : "End";
    endpoint.detail = descriptions.join("\n\n");
    nodes = nodes.filter((n) => !removed.has(n.id));
    edges = edges.map((e) => (removed.has(e.target) ? { ...e, target: endpoint.id } : e));
  }
  // Outcomes that resume at the same continuation share one route and label.
  const routes = new Map<string, FlowEdge>();
  for (const e of edges) {
    const key = JSON.stringify([e.source, e.target]);
    const existing = routes.get(key);
    if (!existing) routes.set(key, { ...e });
    else if (e.label && e.label !== existing.label)
      existing.label = [existing.label, e.label].filter(Boolean).join(" / ");
  }
  return {
    nodes,
    edges: [...routes.values()],
    truncated,
    source: print(expanded, { maxWidth: 80 }),
  };
}
