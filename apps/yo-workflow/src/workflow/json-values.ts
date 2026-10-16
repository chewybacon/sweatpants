import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import { Eval, type TisynExpr } from "@tisyn/ir";
import { expandConstructors } from "./constructor-syntax.ts";

export const JSON_VALUE_OPERATION = "json.value";
const constructors = {
  JsonGet: "get",
  JsonSet: "set",
  JsonAppend: "append",
  JsonLength: "length",
  JsonKeys: "keys",
  JsonStringify: "stringify",
} as const;
const arities: Record<string, number> = {
  array: 1,
  get: 2,
  set: 3,
  append: 2,
  length: 1,
  keys: 1,
  stringify: 1,
};
export function expandJsonSyntax(source: string): string {
  return expandConstructors(
    source,
    Object.fromEntries(Object.entries(constructors).map(([name, op]) => [name, `__json_${op}`])),
  );
}
export function lowerJsonSyntax(value: TisynExpr): TisynExpr {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(lowerJsonSyntax);
  }
  const node = value as Record<string, TisynExpr>;
  if (node.tisyn === "eval" && typeof node.id === "string" && node.id.startsWith("__json_")) {
    const op = node.id.slice(7);
    if (
      !Object.hasOwn(arities, op) ||
      !Array.isArray(node.data) ||
      node.data.length !== arities[op]
    ) {
      throw new Error(`Invalid JSON constructor arguments: ${op}`);
    }
    return Eval(JSON_VALUE_OPERATION, { op, args: node.data.map(lowerJsonSyntax) }) as TisynExpr;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, lowerJsonSyntax(child as TisynExpr)]),
  ) as TisynExpr;
}

/** Bounded pure values; no code evaluation, document access, or implicit model context. */
export function evaluateJsonValue(input: Json): Json {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.op !== "string" ||
    !Array.isArray(input.args) ||
    !Object.hasOwn(arities, input.op) ||
    input.args.length !== arities[input.op]
  ) {
    throw new Error("Invalid json.value operation");
  }
  const [value, key, replacement] = input.args;
  let result: Json;
  switch (input.op) {
    case "array":
      if (!Array.isArray(value)) {
        throw new Error("Collection input must be an array");
      }
      result = value;
      break;
    case "get":
    case "set": {
      if (!value || typeof value !== "object") {
        throw new Error("JSON access requires an object or array");
      }
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error("JSON key must be a string or array index");
      }
      if (["__proto__", "prototype", "constructor"].includes(String(key))) {
        throw new Error("Unsafe JSON key");
      }
      if (Array.isArray(value)) {
        const index =
          typeof key === "number" ? key : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : NaN;
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
          throw new Error("JSON array index out of bounds");
        }
        result =
          input.op === "get"
            ? value[index]!
            : value.map((entry, i) => (i === index ? replacement! : entry));
      } else {
        if (typeof key !== "string") {
          throw new Error("JSON object key must be a string");
        }
        result =
          input.op === "get"
            ? Object.hasOwn(value, key)
              ? value[key]!
              : null
            : { ...value, [key]: replacement! };
      }
      break;
    }
    case "append":
      if (!Array.isArray(value)) {
        throw new Error("JsonAppend requires an array");
      }
      result = [...value, key!];
      break;
    case "length":
      if (!Array.isArray(value) && typeof value !== "string") {
        throw new Error("JsonLength requires an array or string");
      }
      result = value.length;
      break;
    case "keys":
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("JsonKeys requires an object");
      }
      result = Object.keys(value);
      break;
    case "stringify":
      result = canonicalJson(value!);
      break;
    default:
      throw new Error("Unsupported JSON operation");
  }
  assertJson(result);
  if (new TextEncoder().encode(canonicalJson(result)).length > 32_768) {
    throw new Error("JSON value exceeds 32 KiB");
  }
  return structuredClone(result);
}
