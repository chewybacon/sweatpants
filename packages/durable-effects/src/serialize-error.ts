import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { z } from "zod";
import type { SerializedEffectError } from "./contract.ts";

const MAX_ERROR_DETAILS_BYTES = 64 * 1024;

/** Converts a thrown value to the journal's bounded, JSON-safe failure record. */
export function serializeEffectError(error: unknown): SerializedEffectError {
  const parsed = z.object({ code: z.string() }).loose().safeParse(error);
  const failure = {
    code: parsed.success ? parsed.data.code : "effect_failed",
    message: error instanceof Error ? error.message : "Durable effect failed",
  };
  if (error === null || typeof error !== "object" || !("details" in error)) {
    return failure;
  }
  try {
    const details = canonicalSnapshot(error.details);
    if (new TextEncoder().encode(details.canonical).byteLength <= MAX_ERROR_DETAILS_BYTES) {
      return { ...failure, details: details.value as Json };
    }
  } catch {
    // Unserializable details must not prevent the failure itself from being recorded.
  }
  return failure;
}
