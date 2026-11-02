import { serialize, deserialize } from "node:v8";
import type { Serializer } from "@sweatpan.ts/storage";

/**
 * Node's V8 binary representation for the Node SQLite adapter. Supports native
 * structured data such as Maps, bigint and typed arrays; functions are rejected.
 * This is not a JSON or cross-platform checkpoint format. No domain validation or
 * schema traversal is added around the native serializer.
 */
export const v8Serializer: Serializer = {
  format: "node-v8:1",
  encode: serialize,
  decode: deserialize,
};
