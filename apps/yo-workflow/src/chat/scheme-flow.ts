import type { FlowEdge, FlowNode } from "./flow.ts";

type Expr = { text: string; string?: string } | Expr[];
const atom = (x: Expr | undefined) => (x && !Array.isArray(x) ? x.text : undefined);
const head = (x: Expr | undefined) => (Array.isArray(x) ? atom(x[0]) : undefined);
const show = (x: Expr): string => (Array.isArray(x) ? `(${x.map(show).join(" ")})` : x.text);

function describe(x: Expr): string {
  if (!Array.isArray(x)) {
    return x.string ?? x.text;
  }
  const name = head(x);
  if (name === "field" && x.length === 3) {
    return `${describe(x[1])}.${describe(x[2])}`;
  }
  if (name === "not" && x.length === 2) {
    return `not (${describe(x[1])})`;
  }
  const operators: Record<string, string> = {
    "equal?": "=",
    "string=?": "=",
    "=": "=",
    ">": ">",
    "<": "<",
    ">=": "≥",
    "<=": "≤",
    and: "and",
    or: "or",
  };
  if (name && operators[name]) {
    return x.slice(1).map(describe).join(` ${operators[name]} `);
  }
  return show(x);
}

/** Presentation reader only. Hoot remains the language parser and validator. */
function read(source: string): Expr {
  let at = 0;
  function space() {
    while (at < source.length) {
      if (/\s/.test(source[at])) {
        at++;
      } else if (source[at] === ";") {
        while (at < source.length && source[at] !== "\n") {
          at++;
        }
      } else {
        break;
      }
    }
  }
  function expr(depth: number): Expr {
    if (depth > 128) {
      throw new Error("Preview nesting limit reached");
    }
    space();
    const start = at,
      c = source[at++];
    if (!c) {
      throw new Error("Incomplete expression");
    }
    if (c === "(") {
      const values: Expr[] = [];
      space();
      while (source[at] !== ")") {
        values.push(expr(depth + 1));
        space();
      }
      at++;
      return values;
    }
    if (c === ")") {
      throw new Error("Unexpected closing parenthesis");
    }
    if (c === "'" || c === "`" || c === ",") {
      const splice = c === "," && source[at] === "@";
      if (splice) {
        at++;
      }
      return [
        {
          text:
            c === "'"
              ? "quote"
              : c === "`"
                ? "quasiquote"
                : splice
                  ? "unquote-splicing"
                  : "unquote",
        },
        expr(depth + 1),
      ];
    }
    if (c === '"') {
      let value = "",
        closed = false;
      while (at < source.length) {
        const ch = source[at++];
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === "\\") {
          value += source[at++] ?? "";
        } else {
          value += ch;
        }
      }
      if (!closed) {
        throw new Error("Incomplete string");
      }
      return { text: source.slice(start, at), string: value };
    }
    while (at < source.length && !/[\s();]/.test(source[at])) {
      at++;
    }
    const text = source.slice(start, at);
    if (text.startsWith("#") && !["#t", "#f"].includes(text)) {
      throw new Error("Reader syntax is available in source; this preview does not expand it");
    }
    return { text };
  }
  const result = expr(0);
  space();
  if (at !== source.length) {
    throw new Error("Expected one expression");
  }
  return result;
}

type Fn = { params: Expr[]; body: Expr[]; scope: Env };
type Env = Map<string, Fn | null>;
const pureNames = new Set(
  "+ - * / quotient = < > <= >= remainder modulo abs max min zero? positive? negative? cons car cdr cadr caddr list null? pair? length reverse append string-append number->string string->number string=? string-length substring equal? string? number? boolean? symbol? integer? exact-integer? not object field object-set array array-ref array-length array-append json-null".split(
    " ",
  ),
);
const effects: Record<string, [string, FlowNode["origin"]]> = {
  ask: ["Ask", "authored"],
  sample: ["Sample", "builtin"],
  random: ["Random", "builtin"],
  decision: ["Decision", "builtin"],
  echo: ["Echo", "authored"],
  document_create: ["Create document", "authored"],
  document_read: ["Read document", "authored"],
  document_edit: ["Edit document", "authored"],
  present_choices: ["Present choices", "authored"],
  display_document: ["Display document", "authored"],
};

/** A conservative continuation graph: never executes user code or expands authored macros. */
export function createSchemeFlow(source: string) {
  if (source.length > 12000) {
    throw new Error("Preview source limit reached");
  }
  const expression = read(source);
  let nodes: FlowNode[] = [],
    edges: FlowEdge[] = [],
    visits = 0,
    inspections = 0,
    truncated = false;
  const active = new Map<Fn, { entry: string; continuation: string }>();
  function node(kind: FlowNode["kind"], title: string, detail = "", origin?: FlowNode["origin"]) {
    const id = `scheme-${nodes.length}`;
    nodes.push({
      id,
      kind,
      title: title.length > 70 ? title.slice(0, 69) + "…" : title,
      detail,
      origin,
    });
    return id;
  }
  function edge(source: string, target: string, label?: string) {
    edges.push({ source, target, label });
  }
  const start = node("entry", "Start"),
    end = node("exit", "End");
  function fn(x: Expr | undefined, env: Env): Fn | undefined {
    if (head(x) === "lambda" && Array.isArray(x) && Array.isArray(x[1])) {
      return { params: x[1], body: x.slice(2), scope: env };
    }
    return env.get(atom(x) ?? "") ?? undefined;
  }
  function sequence(xs: Expr[], env: Env, k: string): string {
    const scope = new Map(env);
    const bodies: Expr[] = [];
    for (const x of xs) {
      if (head(x) === "define" && Array.isArray(x)) {
        if (Array.isArray(x[1])) {
          scope.set(atom(x[1][0])!, { params: x[1].slice(1), body: x.slice(2), scope });
        } else {
          scope.set(atom(x[1])!, fn(x[2], scope) ?? null);
          bodies.push(x[2]);
        }
      } else {
        bodies.push(x);
      }
    }
    return bodies.reduceRight((next, x) => compile(x, scope, next), k);
  }
  function invoke(f: Fn, args: Expr[], caller: Env, k: string, name: string): string {
    const known = active.get(f);
    if (known) {
      if (known.continuation === k) {
        return known.entry;
      }
      const call = node("call", `Call ${name}`, "Recursive call with a different continuation");
      edge(call, k);
      return call;
    }
    const scope = new Map(f.scope);
    f.params.forEach((p, i) => scope.set(atom(p)!, fn(args[i], caller) ?? null));
    if (f.body.every((value) => pure(value, scope, new Set([f])))) {
      return k;
    }
    const anchor = node("entry", name);
    active.set(f, { entry: anchor, continuation: k });
    edge(anchor, sequence(f.body, scope, k));
    active.delete(f);
    return anchor;
  }
  function pure(x: Expr, env: Env, visiting = new Set<Fn>()): boolean {
    if (++inspections > 5000) {
      truncated = true;
      return false;
    }
    if (!Array.isArray(x)) {
      return true;
    }
    const name = head(x) ?? "";
    if (env.has(name)) {
      const target = env.get(name);
      if (!target || visiting.has(target)) {
        return false;
      }
      const scope = new Map(target.scope);
      target.params.forEach((p) => scope.set(atom(p)!, null));
      const seen = new Set(visiting).add(target);
      return (
        x.slice(1).every((value) => pure(value, env, visiting)) &&
        target.body.every((value) => pure(value, scope, seen))
      );
    }
    if (["quote", "lambda"].includes(name)) {
      return true;
    }
    if (name === "cond") {
      return x
        .slice(1)
        .every(
          (clause) =>
            Array.isArray(clause) &&
            atom(clause[1]) !== "=>" &&
            clause.every((value) => pure(value, env, visiting)),
        );
    }
    if (name === "case") {
      return (
        pure(x[1], env, visiting) &&
        x
          .slice(2)
          .every(
            (clause) =>
              Array.isArray(clause) &&
              atom(clause[1]) !== "=>" &&
              clause.slice(1).every((value) => pure(value, env, visiting)),
          )
      );
    }
    if (pureNames.has(name) || ["if", "and", "or", "begin"].includes(name)) {
      return x.slice(1).every((value) => pure(value, env, visiting));
    }
    return false;
  }
  function compile(x: Expr, env: Env, k: string): string {
    if (++visits > 400) {
      truncated = true;
      return opaque(x, k);
    }
    if (!Array.isArray(x) || !x.length || pure(x, env)) {
      return k;
    }
    const name = head(x) ?? "computed call";
    if (env.has(name)) {
      const target = env.get(name);
      return sequence(
        x.slice(1),
        env,
        target ? invoke(target, x.slice(1), env, k, name) : opaque(x, k),
      );
    }
    if (["quote", "lambda", "syntax-rules"].includes(name)) {
      return k;
    }
    if (name === "quasiquote") {
      return opaque(x, k);
    } // unquotes may contain effects
    if (name === "begin") {
      return sequence(x.slice(1), env, k);
    }
    if (["let", "let*", "letrec"].includes(name)) {
      const named = name === "let" && atom(x[1]);
      const pairs = x[named ? 2 : 1];
      if (!Array.isArray(pairs) || pairs.some((p) => !Array.isArray(p) || p.length !== 2)) {
        return opaque(x, k);
      }
      const entries = pairs as Expr[][],
        scope = new Map(env),
        body = x.slice(named ? 3 : 2);
      if (named) {
        const f: Fn = { params: entries.map((p) => p[0]), body, scope };
        scope.set(named, f);
        const target = invoke(
          f,
          entries.map((p) => p[1]),
          env,
          k,
          named,
        );
        return sequence(
          entries.map((p) => p[1]),
          env,
          target,
        );
      }
      const initializers: { value: Expr; env: Env }[] = [];
      for (const [key, value] of entries) {
        const bindingEnv = name === "letrec" ? scope : name === "let*" ? new Map(scope) : env;
        initializers.push({ value, env: bindingEnv });
        scope.set(atom(key)!, fn(value, bindingEnv) ?? null);
      }
      return initializers.reduceRight(
        (next, item) => compile(item.value, item.env, next),
        sequence(body, scope, k),
      );
    }
    if (name === "let-syntax" || name === "letrec-syntax") {
      return opaque(x, k);
    }
    if (name === "if" || name === "when" || name === "unless") {
      const branch = node("branch", describe(x[1]), show(x[1]));
      const yes = name === "if" ? compile(x[2], env, k) : sequence(x.slice(2), env, k);
      const no = name === "if" && x[3] ? compile(x[3], env, k) : k;
      edge(branch, yes, name === "unless" ? "no" : "yes");
      edge(branch, no, name === "unless" ? "yes" : "no");
      return compile(x[1], env, branch);
    }
    if (name === "cond") {
      return x.slice(1).reduceRight((next, clause) => {
        if (!Array.isArray(clause) || clause.length < 2 || atom(clause[1]) === "=>") {
          return opaque(clause, next);
        }
        if (atom(clause[0]) === "else") {
          return sequence(clause.slice(1), env, k);
        }
        const branch = node("branch", describe(clause[0]), show(clause[0]));
        edge(branch, sequence(clause.slice(1), env, k), "yes");
        edge(branch, next, "no");
        return compile(clause[0], env, branch);
      }, k);
    }
    if (name === "match-result") {
      const clauses = x.slice(3);
      if (
        !clauses.length ||
        clauses.some((clause) => !Array.isArray(clause) || clause.length < 3 || !atom(clause[1]))
      ) {
        return opaque(x, k);
      }
      const branch = node("branch", `Result: ${describe(x[2])}`, show(x));
      for (const clause of clauses) {
        if (!Array.isArray(clause)) {
          continue;
        }
        const scope = new Map(env);
        scope.set(atom(clause[1])!, null);
        edge(branch, sequence(clause.slice(2), scope, k), describe(clause[0]));
      }
      return sequence(x.slice(1, 3), env, branch);
    }
    if (name === "case") {
      const branch = node("branch", describe(x[1]), show(x[1]));
      let fallback = false;
      for (const clause of x.slice(2)) {
        if (!Array.isArray(clause) || atom(clause[1]) === "=>") {
          return opaque(x, k);
        }
        fallback ||= atom(clause[0]) === "else";
        edge(branch, sequence(clause.slice(1), env, k), show(clause[0]));
      }
      if (!fallback) {
        edge(branch, k, "otherwise");
      }
      return compile(x[1], env, branch);
    }
    if (name === "and" || name === "or") {
      return x.slice(1).reduceRight((next, value, i) => {
        if (i === x.length - 2) {
          return compile(value, env, next);
        }
        const branch = node("branch", describe(value), show(value));
        edge(branch, next, name === "and" ? "yes" : "no");
        edge(branch, k, name === "and" ? "no" : "yes");
        return compile(value, env, branch);
      }, k);
    }
    if (name === "with-reply" && !env.has(name)) {
      const ask = node("yield", "Ask", show(x[1]), "authored");
      for (const [index, label] of [
        [2, "accepted"],
        [3, "declined / cancelled"],
      ] as const) {
        const callback = fn(x[index], env);
        edge(
          ask,
          callback ? invoke(callback, [], env, k, "Reply continuation") : opaque(x[index], k),
          label,
        );
      }
      return compile(x[1], env, ask);
    }
    const capability = name === "effect" && !Array.isArray(x[1]) ? x[1]?.string : name;
    const effect = capability && effects[capability];
    if (effect || name === "invoke") {
      const n = node(
        "yield",
        effect ? effect[0] : "Invoke child",
        show(x),
        effect ? effect[1] : "builtin",
      );
      edge(n, k);
      return sequence(x.slice(name === "effect" ? 2 : 1), env, n);
    }
    if (pureNames.has(name)) {
      return sequence(x.slice(1), env, k);
    }
    return opaque(x, k);
  }
  function opaque(x: Expr, k: string): string {
    const n = node("call", `Evaluate ${head(x) ?? "expression"}`, show(x));
    nodes[nodes.length - 1].caption = "Runtime structure — see source";
    edge(n, k);
    return n;
  }
  edge(start, compile(expression, new Map(), end));
  for (const n of [...nodes]) {
    if (n.kind !== "entry" || n.id === start) {
      continue;
    }
    const outgoing = edges.filter((e) => e.source === n.id);
    if (outgoing.length !== 1 || outgoing[0].target === n.id) {
      continue;
    }
    edges = edges
      .filter((e) => e.source !== n.id)
      .map((e) => (e.target === n.id ? { ...e, target: outgoing[0].target } : e));
    nodes = nodes.filter((item) => item.id !== n.id);
  }
  const routes = new Map<string, FlowEdge>();
  for (const e of edges) {
    const key = `${e.source}/${e.target}`,
      existing = routes.get(key);
    if (!existing) {
      routes.set(key, { ...e });
    } else if (e.label && e.label !== existing.label) {
      existing.label = [existing.label, e.label].filter(Boolean).join(" / ");
    }
  }
  return { nodes, edges: [...routes.values()], truncated, source };
}
