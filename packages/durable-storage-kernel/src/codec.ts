import { canonicalJson, parseJsonText, type Json } from "@sweatpants/foundation";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface DurableValueCodec<T> {
  encode(value: T): Uint8Array;
  decode(value: Uint8Array): T;
}

export function defineJsonCodec<T extends Json>(
  validate: (value: Json) => T,
): DurableValueCodec<T> {
  return Object.freeze({
    encode(value: T): Uint8Array {
      return encoder.encode(canonicalJson(value));
    },
    decode(value: Uint8Array): T {
      return validate(parseJsonText(decoder.decode(value), "durable value"));
    },
  });
}

export function encodeJsonValue(value: Json): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

export function decodeJsonValue(value: Uint8Array, label = "durable value"): Json {
  return parseJsonText(decoder.decode(value), label);
}

export function durableKey(...parts: readonly string[]): string {
  return canonicalJson(parts);
}

export function decodeDurableKey(value: string): readonly string[] {
  const decoded = parseJsonText(value, "durable key");
  if (!Array.isArray(decoded) || decoded.some((part) => typeof part !== "string")) {
    throw new DurableMutationInvalid("Durable key must be a canonical string tuple");
  }
  if (canonicalJson(decoded) !== value) {
    throw new DurableMutationInvalid("Durable key is not canonical");
  }
  return decoded as readonly string[];
}

// Kept here to avoid a codec/contract import cycle in public declarations.
export class DurableMutationInvalid extends Error {
  readonly code = "durable_mutation_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableMutationInvalid";
  }
}
