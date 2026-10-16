import { Call, Eq, Eval, Get, If, Let, Ref, Throw, type Expr, type TisynExpr } from "@tisyn/ir";
import { expandConstructors } from "./constructor-syntax.ts";
import { responseSchema } from "./response-schema.ts";

const markers = {
  Ask: "__exchange_ask",
  Sample: "__exchange_sample",
  OnAccepted: "__exchange_accepted",
  OnParsed: "__exchange_parsed",
  ObjectSchema: "__schema_object",
  StringSchema: "__schema_string",
  NumberSchema: "__schema_number",
  IntegerSchema: "__schema_integer",
  BooleanSchema: "__schema_boolean",
  EnumSchema: "__schema_enum",
  ArraySchema: "__schema_array",
};

export function expandExchangeSyntax(source: string): string {
  return expandConstructors(source, markers);
}

function object(value: unknown): value is Record<string, TisynExpr> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !("tisyn" in value)
  );
}

/** Pure authoring sugar: the kernel still executes ordinary effects, bindings, and calls. */
export function lowerExchangeSyntax(ir: TisynExpr): TisynExpr {
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
      name = `__exchange_${counter++}`;
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
    if (
      node.tisyn !== "eval" ||
      typeof node.id !== "string" ||
      !Object.values(markers).includes(node.id)
    ) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, lower(child)]));
    }
    if (!Array.isArray(node.data)) {
      throw new Error("Invalid exchange constructor arguments");
    }
    const args = node.data;
    if (node.id === markers.Ask || node.id === markers.Sample) {
      const name = node.id === markers.Ask ? "ask" : "sample";
      if (args.length !== 1) {
        throw new Error(`${name} requires one request expression`);
      }
      return Eval(name, lower(args[0])) as TisynExpr;
    }
    if (node.id === markers.OnAccepted || node.id === markers.OnParsed) {
      const accepted = node.id === markers.OnAccepted;
      const name = accepted ? "OnAccepted" : "OnParsed";
      if (args.length !== 3) {
        throw new Error(`${name} requires a result and two callbacks`);
      }
      for (const [index, arity] of [
        [1, 2],
        [2, 1],
      ]) {
        const fn = args[index];
        if (fn && typeof fn === "object" && !Array.isArray(fn) && fn.tisyn === "ref") {
          continue;
        }
        if (
          !fn ||
          Array.isArray(fn) ||
          typeof fn !== "object" ||
          fn.tisyn !== "fn" ||
          !Array.isArray(fn.params) ||
          fn.params.length !== arity
        ) {
          throw new Error(
            `${name} callback ${index} requires Fn with ${arity} parameters or a function Ref`,
          );
        }
      }
      const result = fresh();
      const tag = Get(Ref(result), accepted ? "action" : "status");
      const success = Call(
        lower(args[1]) as Expr<(...args: unknown[]) => unknown>,
        Get(Ref(result), accepted ? "content" : "parsed"),
        Get(Ref(result), "exchange"),
      );
      const failure = Call(
        lower(args[2]) as Expr<(...args: unknown[]) => unknown>,
        accepted ? Ref(result) : Get(Ref(result), "parseError"),
      );
      const unexpected = Throw(`${name} received an unexpected result`) as TisynExpr;
      const stopped = accepted
        ? If(Eq(tag, "decline"), failure, If(Eq(tag, "cancel"), failure, unexpected))
        : If(Eq(tag, "invalid"), failure, unexpected);
      return Let(
        result,
        lower(args[0]),
        If(Eq(tag, accepted ? "accept" : "ok"), success, stopped),
      ) as TisynExpr;
    }
    const values = args.map(lower);
    let schema: Record<string, TisynExpr>;
    if (node.id === markers.ObjectSchema) {
      if (values.length !== 1 || !object(values[0])) {
        throw new Error("ObjectSchema requires a static field object");
      }
      schema = {
        type: "object",
        properties: values[0],
        required: Object.keys(values[0]),
        additionalProperties: false,
      };
    } else if (node.id === markers.EnumSchema) {
      if (
        !values.length ||
        !values.every(
          (item) => item === null || ["string", "boolean", "number"].includes(typeof item),
        )
      ) {
        throw new Error("EnumSchema requires JSON scalar literals");
      }
      schema = { enum: values };
    } else if (node.id === markers.ArraySchema) {
      if (values.length !== 1 || !object(values[0])) {
        throw new Error("ArraySchema requires one static item schema");
      }
      schema = { type: "array", items: values[0] };
    } else {
      if (values.length !== 0) {
        throw new Error("Scalar schema constructors take no arguments");
      }
      const types: Record<string, string> = {
        [markers.StringSchema]: "string",
        [markers.NumberSchema]: "number",
        [markers.IntegerSchema]: "integer",
        [markers.BooleanSchema]: "boolean",
      };
      schema = { type: types[node.id] };
    }
    responseSchema(schema);
    return schema;
  }
  return lower(ir);
}
