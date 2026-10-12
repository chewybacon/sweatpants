import { If, type Expr, type TisynExpr } from "@tisyn/ir";
import { expandConstructors } from "./constructor-syntax.ts";

const markers = {
  WithMacros: "__macro_scope",
  Use: "__macro_use",
  Hole: "__macro_hole",
  When: "__macro_when",
  Unless: "__macro_unless",
};
type Definition = { params: string[]; body: TisynExpr };
function object(value: unknown): value is Record<string, TisynExpr> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function expandMacroSyntax(source: string): string {
  return expandConstructors(source, markers);
}

/** Bounded, binding-free syntax templates. No evaluation or effects during expansion. */
export function lowerMacroSyntax(ir: TisynExpr): TisynExpr {
  let budget = 4000;
  let expansions = 0;
  function charge(): void {
    if (--budget < 0) {
      throw new Error("Macro expansion exceeds 4000 values");
    }
  }
  function template(
    value: TisynExpr,
    params: Set<string>,
    args?: Map<string, TisynExpr>,
  ): TisynExpr {
    charge();
    if (Array.isArray(value)) {
      return value.map((child) => template(child, params, args));
    }
    if (!object(value)) {
      return value;
    }
    if (value.tisyn === "eval" && value.id === markers.Hole) {
      if (
        !Array.isArray(value.data) ||
        value.data.length !== 1 ||
        typeof value.data[0] !== "string" ||
        !params.has(value.data[0])
      ) {
        throw new Error("Hole requires one declared macro parameter");
      }
      return args ? args.get(value.data[0])! : value;
    }
    // Inserted argument subtrees are returned above without inspecting or rebinding them.
    if (
      value.tisyn === "fn" ||
      value.tisyn === "ref" ||
      (value.tisyn === "eval" && ["let", "try", markers.WithMacros].includes(String(value.id)))
    ) {
      throw new Error(
        "Macro templates cannot introduce bindings or Ref; pass expressions through Hole",
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, template(child, params, args)]),
    );
  }
  function lower(value: TisynExpr, definitions: Map<string, Definition>, depth: number): TisynExpr {
    charge();
    if (depth > 64) {
      throw new Error("Macro expansion nesting exceeds 64 levels");
    }
    if (Array.isArray(value)) {
      return value.map((child) => lower(child, definitions, depth + 1));
    }
    if (!object(value)) {
      return value;
    }
    if (value.tisyn === "eval" && Object.values(markers).includes(String(value.id))) {
      const args = value.data;
      if (!Array.isArray(args)) {
        throw new Error("Invalid macro arguments");
      }
      if (value.id === markers.WithMacros) {
        if (args.length !== 2 || !object(args[0]) || "tisyn" in args[0]) {
          throw new Error("WithMacros requires a static definitions object and a body");
        }
        const scope = new Map(definitions);
        for (const [name, definition] of Object.entries(args[0])) {
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || scope.has(name)) {
            throw new Error("Macro names must be unique identifiers");
          }
          if (
            !object(definition) ||
            Object.keys(definition).length !== 2 ||
            !Object.hasOwn(definition, "body") ||
            !Object.hasOwn(definition, "params") ||
            !Array.isArray(definition.params) ||
            definition.params.length > 8 ||
            !definition.params.every((param) => typeof param === "string") ||
            new Set(definition.params).size !== definition.params.length
          ) {
            throw new Error("Macro requires params (up to 8 unique strings) and body");
          }
          const params = definition.params as string[];
          template(definition.body, new Set(params));
          scope.set(name, { params, body: definition.body });
          if (scope.size > 16) {
            throw new Error("At most 16 macros may be in scope");
          }
        }
        return lower(args[1], scope, depth + 1);
      }
      if (value.id === markers.Hole) {
        throw new Error("Hole is only valid inside a macro template");
      }
      if (++expansions > 64) {
        throw new Error("Macro expansion exceeds 64 calls (possible recursive macro)");
      }
      if (value.id === markers.When || value.id === markers.Unless) {
        if (args.length !== 2) {
          throw new Error("When/Unless require a condition and a body");
        }
        const [condition, body] = args.map((arg) => lower(arg, definitions, depth + 1));
        return (
          value.id === markers.When
            ? If<unknown>(condition as Expr<boolean>, body!, null)
            : If<unknown>(condition as Expr<boolean>, null, body!)
        ) as TisynExpr;
      }
      const [name, ...actuals] = args;
      const definition = typeof name === "string" ? definitions.get(name) : undefined;
      if (!definition) {
        throw new Error(`Unknown macro: ${String(name)}`);
      }
      if (actuals.length !== definition.params.length) {
        throw new Error(`Macro ${name} requires ${definition.params.length} arguments`);
      }
      const bindings = new Map(definition.params.map((param, index) => [param, actuals[index]]));
      return lower(
        template(definition.body, new Set(definition.params), bindings),
        definitions,
        depth + 1,
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, lower(child, definitions, depth + 1)]),
    );
  }
  return lower(ir, new Map(), 0);
}
