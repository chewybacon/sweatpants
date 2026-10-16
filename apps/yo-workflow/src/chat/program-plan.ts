import {
  isEvalNode,
  isFnNode,
  isQuoteNode,
  isRefNode,
  isTisynObject,
  print,
  type TisynExpr,
} from "@tisyn/ir";
import { parseTisynSource } from "../workflow/source.ts";

const operators: Record<string, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  add: "+",
  sub: "−",
  mul: "×",
  div: "/",
  mod: "%",
  and: "and",
  or: "or",
};

function fields(expr: TisynExpr): Record<string, TisynExpr> | undefined {
  return isEvalNode(expr) && isQuoteNode(expr.data) && isTisynObject(expr.data.expr)
    ? expr.data.expr
    : undefined;
}

/** Readable labels only. This does not evaluate expressions or resolve bindings. */
function describe(expr: TisynExpr): string {
  if (isRefNode(expr)) {
    return expr.name;
  }
  const data = fields(expr);
  if (isEvalNode(expr) && data) {
    if (expr.id === "get" && typeof data.key === "string") {
      const key = /^[a-zA-Z_$][\w$]*$/.test(data.key)
        ? `.${data.key}`
        : `[${JSON.stringify(data.key)}]`;
      return `${describe(data.obj)}${key}`;
    }
    if (Object.hasOwn(operators, expr.id)) {
      return `(${describe(data.a)} ${operators[expr.id]} ${describe(data.b)})`;
    }
  }
  return print(expr, { compact: true });
}

/** Mermaid entity escapes keep labels from becoming graph syntax or HTML. */
function label(text: string): string {
  const short = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  return Array.from(short.replace(/\s+/g, " "), (char) =>
    /[a-zA-Z0-9 ]/.test(char) ? char : `#${char.codePointAt(0)};`,
  ).join("");
}

interface Flow {
  entry: string;
  exits: string[];
}
export interface ProgramPlan {
  diagram: string;
  source: string;
  steps: readonly string[];
  truncated: boolean;
}

/** Top-level control flow. Nested value expressions stay in labels, not simulated steps. */
export function createProgramPlan(source: string): ProgramPlan {
  const ir = parseTisynSource(source);
  const lines = ["flowchart TD"];
  let diagramLength = lines[0].length;
  function append(...added: string[]): void {
    lines.push(...added);
    diagramLength += added.reduce((length, line) => length + line.length + 1, 0);
  }
  const steps: string[] = [];
  let omitted: string | undefined;
  const definitions: { name: string; entry: string; body: TisynExpr }[] = [];
  const calls: { node: string; name: string }[] = [];
  // Caller-scoped functions can be shadowed. Only link globally unambiguous names;
  // this is a static plan, not a binding resolver or an interpreter.
  const bindings = new Map<string, number>();
  function countBindings(value: TisynExpr): void {
    if (value === null || typeof value !== "object") {
      return;
    }
    const data = fields(value);
    const names = isFnNode(value)
      ? value.params
      : isEvalNode(value) && value.id === "let" && typeof data?.name === "string"
        ? [data.name]
        : [];
    for (const name of names) {
      bindings.set(name, (bindings.get(name) ?? 0) + 1);
    }
    for (const child of Object.values(value)) {
      countBindings(child);
    }
  }
  countBindings(ir);
  function node(text: string, kind: "step" | "decision" | "tool" = "step"): string {
    const id = `n${steps.length}`;
    steps.push(text);
    const quoted = `"${label(text)}"`;
    append(`${id}${kind === "decision" ? `{${quoted}}` : `[${quoted}]`}:::plan-${kind}`);
    return id;
  }
  function connect(from: string[], to: string, branch?: "yes" | "no"): void {
    for (const id of from) {
      append(`${id} -->${branch ? `|${branch}|` : ""} ${to}`);
    }
  }
  function sequence(exprs: readonly TisynExpr[]): Flow {
    const first = flow(exprs[0] ?? null);
    let exits = first.exits;
    for (const expr of exprs.slice(1)) {
      if (!exits.length) {
        break;
      }
      const next = flow(expr);
      connect(exits, next.entry);
      exits = next.exits;
    }
    return { entry: first.entry, exits };
  }
  function flow(expr: TisynExpr): Flow {
    // Keep large expanded programs renderable without pretending this is the full plan.
    if (steps.length >= 120 || diagramLength >= 24_000) {
      omitted ??= node("Additional control flow omitted — see Tisyn source");
      return { entry: omitted, exits: [] };
    }
    const data = fields(expr);
    if (isEvalNode(expr)) {
      if (["seq", "let", "if", "call", "while"].includes(expr.id) && !data) {
        throw new Error("Computed control-flow fields cannot be diagrammed. See the source.");
      }
      if (expr.id === "seq" && data && Array.isArray(data.exprs) && data.exprs.length) {
        return sequence(data.exprs);
      }
      if (expr.id === "let" && data && typeof data.name === "string" && isFnNode(data.value)) {
        const signature = `${data.name}(${data.value.params.join(", ")})`;
        const declaration = node(`Define ${signature}`);
        const entry = node(`Function ${signature}`);
        definitions.push({ name: data.name, entry, body: data.value.body });
        const body = flow(data.body);
        connect([declaration], body.entry);
        return { entry: declaration, exits: body.exits };
      }
      if (expr.id === "call" && data && Array.isArray(data.args) && isFnNode(data.fn)) {
        const entry = node(`Continue (${data.fn.params.join(", ")})`);
        const body = flow(data.fn.body);
        connect([entry], body.entry);
        return { entry, exits: body.exits };
      }
      if (expr.id === "call" && data && Array.isArray(data.args)) {
        const id = node(`Call ${describe(data.fn)}(${data.args.map(describe).join(", ")})`);
        if (isRefNode(data.fn)) {
          calls.push({ node: id, name: data.fn.name });
        }
        return { entry: id, exits: [id] };
      }
      if (expr.id === "while" && data && Array.isArray(data.exprs)) {
        const condition = node(`While ${describe(data.condition)}`, "decision");
        if (data.exprs.length) {
          const body = sequence(data.exprs);
          connect([condition], body.entry, "yes");
          connect(body.exits, condition);
        } else {
          connect([condition], condition, "yes");
        }
        const result = node("While result");
        connect([condition], result, "no");
        return { entry: condition, exits: [result] };
      }
      if (expr.id === "let" && data) {
        const value = flow(data.value);
        if (!value.exits.length) {
          return value;
        }
        if (typeof data.name !== "string") {
          throw new Error("Let binding name must be a string");
        }
        const binding = node(`Save as ${data.name}`);
        connect(value.exits, binding);
        const body = flow(data.body);
        connect([binding], body.entry);
        return { entry: value.entry, exits: body.exits };
      }
      if (expr.id === "if" && data) {
        const decision = node(describe(data.condition), "decision");
        const yes = flow(data.then);
        const no = flow(data.else ?? null);
        connect([decision], yes.entry, "yes");
        connect([decision], no.entry, "no");
        return { entry: decision, exits: [...yes.exits, ...no.exits] };
      }
      if (expr.id === "throw" && data) {
        return { entry: node(`Throw ${describe(data.message)}`), exits: [] };
      }
      if (expr.id === "echo" || expr.id === "ask") {
        const input =
          isTisynObject(expr.data) && "message" in expr.data ? expr.data.message : expr.data;
        const id = node(`${expr.id === "echo" ? "Echo" : "Ask"} ${describe(input)}`, "tool");
        return { entry: id, exits: [id] };
      }
    }
    const id = node(`Value ${describe(expr)}`);
    return { entry: id, exits: [id] };
  }
  const program = flow(ir);
  if (program.exits.length) {
    connect(program.exits, node("Program result"));
  }
  for (const definition of definitions) {
    const body = flow(definition.body);
    connect([definition.entry], body.entry);
    if (body.exits.length) {
      connect(body.exits, node(`Return from ${definition.name}`));
    }
  }
  for (const call of calls) {
    const definition = definitions.find((value) => value.name === call.name);
    if (definition && bindings.get(call.name) === 1) {
      append(`${call.node} -. call .-> ${definition.entry}`);
    }
  }
  append(
    "classDef plan-tool fill:#163c35,stroke:#71c9b1,color:#f0fff9",
    "classDef plan-decision fill:#453616,stroke:#e2c36f,color:#fff6d6",
    "classDef plan-step fill:#253449,stroke:#8fa4be,color:#f4f7ff",
  );
  return {
    diagram: lines.join("\n"),
    source: print(ir, { maxWidth: 80 }),
    steps,
    truncated: omitted !== undefined,
  };
}
