import type { TisynExpr } from "@tisyn/ir";

type Known =
  | { kind: "answer" }
  | { kind: "decision" }
  | { kind: "fn"; params: string[]; body: unknown }
  | undefined;
type Environment = Map<string, Known>;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Conservative author diagnostics: inspect known shapes without running effects. */
export function validateAuthoring(ir: TisynExpr): void {
  const active = new Set<unknown>();
  let budget = 4000;
  function visit(value: unknown, env: Environment): Known {
    if (--budget < 0) return undefined;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, env));
      return undefined;
    }
    const node = record(value);
    if (!node) return undefined;
    if (node.tisyn === "ref") return env.get(String(node.name));
    if (node.tisyn === "fn") {
      return { kind: "fn", params: node.params as string[], body: node.body };
    }
    if (node.tisyn === "quote") return undefined;
    if (node.tisyn !== "eval") {
      Object.values(node).forEach((child) => visit(child, env));
      return undefined;
    }
    const data = record(node.data);
    const fields = data?.tisyn === "quote" ? record(data.expr) : undefined;
    if (node.id === "let" && fields) {
      const binding = visit(fields.value, env);
      const inner = new Map(env);
      inner.set(String(fields.name), binding);
      return visit(fields.body, inner);
    }
    if (node.id === "call" && fields) {
      const fn = visit(fields.fn, env);
      const args = Array.isArray(fields.args) ? fields.args.map((arg) => visit(arg, env)) : [];
      if (fn?.kind !== "fn") return undefined;
      if (args.length !== fn.params.length) {
        throw new Error(
          `Call expected ${fn.params.length} arguments, got ${args.length}. Pass one argument per Fn parameter.`,
        );
      }
      if (active.has(fn.body)) return undefined;
      const inner = new Map(env);
      fn.params.forEach((name, index) => inner.set(name, args[index]));
      active.add(fn.body);
      const result = visit(fn.body, inner);
      active.delete(fn.body);
      return result;
    }
    if (node.id === "get" && fields) {
      const obj = visit(fields.obj, env);
      visit(fields.key, env);
      if (obj?.kind === "answer" && fields.key === "answer") {
        throw new Error(
          'Classify returns the answer directly. Read "type" and "choice" on that value; do not read another "answer" field.',
        );
      }
      return obj?.kind === "decision" && fields.key === "answer" ? { kind: "answer" } : undefined;
    }
    // Inspect every static branch, but do not infer a value from an unknown branch.
    if (fields) Object.values(fields).forEach((child) => visit(child, env));
    else visit(node.data, env);
    return node.id === "decision" ? { kind: "decision" } : undefined;
  }
  visit(ir, new Map());
}
