import { canonicalJson, parseJsonText } from "@sweatpants/foundation";

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
