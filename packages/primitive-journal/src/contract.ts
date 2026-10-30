import type { Outcome } from "@sweatpants/foundation/computation";
import type { ReadonlyJson as Json } from "@sweatpants/foundation/json";

export type { ReadonlyJson as Json } from "@sweatpants/foundation/json";
export type * from "@sweatpants/foundation/journal";

/** Canonical JSON is both the persistence boundary and the equality rule. */
export function encode(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, encode).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      // Object.entries allocates a fresh array; retain the package ES2022 library target.
      // eslint-disable-next-line unicorn/no-array-sort
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Expected finite JSON data");
}

export function parseOutcome(value: unknown): Outcome<Json, Json> {
  encode(value);
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new Error("Invalid outcome");
  }
  if (value.ok === true && "value" in value && Object.keys(value).length === 2) {
    return { ok: true, value: value.value as Json };
  }
  if (value.ok === false && "error" in value && Object.keys(value).length === 2) {
    return { ok: false, error: value.error as Json };
  }
  throw new Error("Invalid outcome");
}
