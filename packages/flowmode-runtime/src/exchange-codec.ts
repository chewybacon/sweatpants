import { assertJson, type Json } from "../../packages/foundation/dist/index.js";
import type { ExchangeRequest } from "../../packages/flowmode-runtime/src/index.ts";

/** The two experimental compilers share these intrinsic encodings, not the kernel API. */
export function decodeExchange(site: string, encoded: Json): ExchangeRequest {
  if (
    encoded &&
    typeof encoded === "object" &&
    !Array.isArray(encoded) &&
    typeof encoded.binding === "string" &&
    "input" in encoded
  ) {
    return { site, binding: encoded.binding, input: assertJson(encoded.input) };
  }
  if (!Array.isArray(encoded)) {
    throw Error("Invalid guest exchange encoding");
  }
  if (encoded[0] === "exchange" && typeof encoded[1] === "string" && encoded.length === 3) {
    return { site, binding: encoded[1], input: encoded[2]! };
  }
  if (encoded[0] === "elicit" && typeof encoded[1] === "string") {
    return {
      site,
      binding: JSON.stringify(["elicit", encoded[1]]),
      input: { message: encoded[2] ?? encoded[1] },
    };
  }
  if (
    encoded[0] === "effect" &&
    typeof encoded[1] === "string" &&
    typeof encoded[2] === "string" &&
    encoded.length === 4
  ) {
    return { site, binding: JSON.stringify(encoded.slice(0, 3)), input: encoded[3]! };
  }
  if (encoded[0] === "invoke" && encoded.length === 2) {
    return { site, binding: "child", input: encoded[1]! };
  }
  throw Error("Invalid guest exchange encoding");
}
