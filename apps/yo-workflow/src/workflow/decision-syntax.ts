import { expandConstructors } from "./constructor-syntax.ts";
import { Eq, Eval, Get, If, Let, Ref, type TisynExpr } from "@tisyn/ir";

const classifyMarker = "__tisyn_classify";
const switchMarker = "__tisyn_switch";

export function expandDecisionSyntax(source: string): string {
  return expandConstructors(source, { Classify: classifyMarker, Switch: switchMarker });
}

function object(value: unknown): value is Record<string, TisynExpr> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !("tisyn" in value)
  );
}

/** Hygienic, pure lowering. No new kernel operations, eager branches, or provider calls. */
export function lowerDecisionSyntax(ir: TisynExpr): TisynExpr {
  const strings = new Set<string>();
  function collect(value: unknown): void {
    if (typeof value === "string") {
      strings.add(value);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  }
  collect(ir);
  let counter = 0;
  function fresh(): string {
    let name: string;
    do {
      name = `__switch_${counter++}`;
    } while (strings.has(name));
    strings.add(name);
    return name;
  }
  function lower(value: TisynExpr): TisynExpr {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(lower);
    }
    const node = value as Record<string, TisynExpr>;
    if (node.tisyn === "eval" && (node.id === classifyMarker || node.id === switchMarker)) {
      const args = node.data;
      if (!Array.isArray(args)) {
        throw new Error("Invalid decision constructor arguments");
      }
      if (node.id === classifyMarker) {
        if (args.length !== 1 || !object(args[0])) {
          throw new Error("Classify requires one static request object");
        }
        const request = args[0];
        if (
          Object.keys(request).sort().join(",") !== "choices,input,instructions" ||
          !object(request.choices)
        ) {
          throw new Error("Classify requires input, instructions, and a static choices object");
        }
        const choices = Object.entries(request.choices).map(([label, description]) => {
          if (typeof description !== "string") {
            throw new Error("Classify choice descriptions must be strings");
          }
          return { value: label, description };
        });
        return Get(
          Eval("decision", {
            input: lower(request.input),
            question: { type: "choice", instructions: lower(request.instructions), choices },
          }),
          "answer",
        ) as TisynExpr;
      }
      if (args.length !== 3 || !object(args[1])) {
        throw new Error("Switch requires a selector, static case object, and fallback");
      }
      const entries = Object.entries(args[1]);
      if (!entries.length || entries.length > 64) {
        throw new Error("Switch requires 1–64 cases");
      }
      const name = fresh();
      let branch = lower(args[2]);
      for (const [key, body] of entries.reverse()) {
        branch = If(Eq(Ref(name), key), lower(body), branch) as TisynExpr;
      }
      return Let(name, lower(args[0]), branch) as TisynExpr;
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, lower(child)]));
  }
  return lower(ir);
}
