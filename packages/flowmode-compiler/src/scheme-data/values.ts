import type { Json } from "@sweatpants/foundation";
import { encodeNumber } from "./numbers.js";
import { parse, symbolName, type SchemeDatum } from "./read.js";

export function schemeString(value: string): string {
  if (!value.isWellFormed()) {
    throw Error("Invalid Unicode string");
  }
  return (
    '"' +
    value.replace(/["\\\x00-\x1f\x7f]/g, (c) =>
      c === '"' || c === "\\" ? "\\" + c : `\\x${c.charCodeAt(0).toString(16)};`,
    ) +
    '"'
  );
}

// Portable JSON values only. Inspect descriptors without invoking host getters.
export function encodeValue(value: unknown): string {
  const active = new Set<object>();
  let count = 0;
  function encode(value: unknown, depth: number): string {
    if (++count > 10000 || depth > 128) {
      throw Error("Portable value budget exceeded");
    }
    if (value === null) {
      return "json-null";
    }
    if (typeof value === "string") {
      if (!value.isWellFormed()) {
        throw Error("Invalid Unicode string");
      }
      return schemeString(value);
    }
    if (typeof value === "boolean") {
      return value ? "#t" : "#f";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return encodeNumber(value);
    }
    if (typeof value !== "object" || active.has(value)) {
      throw Error("Unsupported portable value");
    }
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw Error("Unsupported host object");
    }
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) {
      throw Error("Symbol properties are not portable");
    }
    const read = (key: string) => {
      const property = descriptors[key];
      if (!property || !("value" in property) || !property.enumerable) {
        throw Error("Unsupported value property");
      }
      return encode(property.value, depth + 1);
    };
    let result;
    if (Array.isArray(value)) {
      if (value.length > 10000) {
        throw Error("Portable value budget exceeded");
      }
      if (Object.keys(descriptors).length !== value.length + 1) {
        throw Error("Unsupported array properties");
      }
      result = `(${Array.from({ length: value.length }, (_, i) => read(String(i))).join(" ")})`;
    } else {
      result = `(json-object ${Object.keys(descriptors)
        .map((key) => {
          if (!key.isWellFormed()) {
            throw Error("Invalid Unicode key");
          }
          return `(${schemeString(key)} ${read(key)})`;
        })
        .join(" ")})`;
    }
    active.delete(value);
    return result;
  }
  return encode(value, 0);
}

export function decodeValue(source: string): Json {
  const forms = parse(source);
  if (forms.length !== 1) {
    throw Error("Expected one boundary value");
  }
  let count = 0;
  function decode(value: SchemeDatum, depth: number): Json {
    if (++count > 10000 || depth > 128) {
      throw Error("Portable value budget exceeded");
    }
    if (symbolName(value) === "json-null") {
      return null;
    }
    if (Array.isArray(value)) {
      if (symbolName(value[0]) === "json-object") {
        const result = {};
        for (const entry of value.slice(1)) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            throw Error("Invalid object entry");
          }
          Object.defineProperty(result, entry[0], {
            value: decode(entry[1], depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return result;
      }
      return value.map((item) => decode(item, depth + 1));
    }
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    throw Error("Nonportable kernel value");
  }
  return decode(forms[0], 0);
}
