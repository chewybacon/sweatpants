import { Add, Call, Eval, Fn, If, Let, Lt, Ref, type Expr, type TisynExpr } from "@tisyn/ir";
import { expandConstructors } from "./constructor-syntax.ts";
import { JSON_VALUE_OPERATION } from "./json-values.ts";

export const bindingsMarker = "__collection_bindings";
const markers = {
  LetMany: bindingsMarker,
  Map: "__collection_map",
  Filter: "__collection_filter",
  Reduce: "__collection_reduce",
};

export function expandCollectionSyntax(source: string): string {
  return expandConstructors(source, markers);
}

/** Ordered bindings and sequential collection loops, lowered to the existing kernel. */
export function lowerCollectionSyntax(ir: TisynExpr): TisynExpr {
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
      name = `__collection_${counter++}`;
    } while (strings.has(name));
    strings.add(name);
    return name;
  }
  function json(op: string, ...args: TisynExpr[]): TisynExpr {
    return Eval(JSON_VALUE_OPERATION, { op, args }) as TisynExpr;
  }
  function call(name: string, ...args: Expr<unknown>[]): TisynExpr {
    return Call<unknown[], unknown>(Ref(name), ...args) as TisynExpr;
  }
  function lower(value: TisynExpr): TisynExpr {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(lower);
    }
    const node = value as Record<string, TisynExpr>;
    if (node.tisyn !== "eval" || !Object.values(markers).includes(String(node.id))) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, lower(child)]));
    }
    const args = node.data;
    if (!Array.isArray(args)) {
      throw new Error("Invalid collection constructor arguments");
    }
    if (node.id === bindingsMarker) {
      if (args.length !== 2 || !Array.isArray(args[0]) || args[0].length > 64) {
        throw new Error("LetMany requires up to 64 [name, expression] pairs and one body");
      }
      let body = lower(args[1]);
      // oxlint-disable-next-line unicorn/no-array-reverse -- The app targets ES2022; reverse a copy.
      for (const binding of [...args[0]].reverse()) {
        if (
          !Array.isArray(binding) ||
          binding.length !== 2 ||
          typeof binding[0] !== "string" ||
          !binding[0].length
        ) {
          throw new Error("Each LetMany binding must be [nonempty name, expression]");
        }
        body = Let(binding[0], lower(binding[1]), body) as TisynExpr;
      }
      return body;
    }
    const reduce = node.id === markers.Reduce;
    if (args.length !== (reduce ? 3 : 2)) {
      throw new Error(
        reduce
          ? "Reduce requires array, initial value, and callback"
          : "Map/Filter require array and callback",
      );
    }
    // Every generated name is absent from the entire authored source, including
    // callback parameters. Nested helpers therefore cannot capture caller state.
    const items = fresh(),
      callback = fresh(),
      initial = fresh();
    const loop = fresh(),
      index = fresh(),
      accumulator = fresh(),
      item = fresh();
    const length = fresh();
    const invocation = reduce
      ? call(callback, Ref(accumulator), Ref(item), Ref(index))
      : call(callback, Ref(item), Ref(index));
    const updated = reduce
      ? invocation
      : node.id === markers.Map
        ? json("append", Ref(accumulator), invocation)
        : (If(
            invocation as Expr<boolean>,
            json("append", Ref(accumulator), Ref(item)),
            Ref(accumulator),
          ) as TisynExpr);
    const body = Let(
      loop,
      Fn(
        [index, accumulator],
        If(
          Lt(Ref(index), Ref(length)),
          Let(item, json("get", Ref(items), Ref(index)), call(loop, Add(Ref(index), 1), updated)),
          Ref(accumulator),
        ),
      ),
      call(loop, 0, Ref(initial)),
    );
    return Let(
      items,
      json("array", lower(args[0])),
      Let(
        initial,
        reduce ? lower(args[1]) : [],
        Let(callback, lower(args[reduce ? 2 : 1]), Let(length, json("length", Ref(items)), body)),
      ),
    ) as TisynExpr;
  }
  return lower(ir);
}
