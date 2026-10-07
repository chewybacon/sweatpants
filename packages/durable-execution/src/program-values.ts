import {
  type Json,
  type SerializedApplicationError,
  canonicalJson,
  cloneJson,
} from "@sweatpants/foundation";

import { CrankError, PullApplicationError } from "./errors.ts";
import { DEFAULT_MAX_INLINE_BYTES } from "./program-authoring-runtime.ts";

/** Canonicalizes an already-accepted durable value without rerunning schema code. */
export function assertReplayedCanonicalValue<T extends Json = Json>(
  value: unknown,
  errorCode = "invalid_descriptor",
): T {
  try {
    return cloneJson(value as T);
  } catch (error) {
    throw new CrankError(errorCode, "Recorded value is not canonical JSON", undefined, {
      cause: error,
    });
  }
}

/** Enforces a canonical UTF-8 payload limit before persistence or transport. */
export function assertInlineSize(value: Json, maxBytes = DEFAULT_MAX_INLINE_BYTES): void {
  const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
  if (bytes > maxBytes) {
    throw new CrankError("payload_too_large", `Canonical payload is ${bytes} bytes`);
  }
}

/** Structured cancellation signal raised inside a resumed durable program task. */
export class DurableProgramCancellation extends Error {
  readonly reason?: string;

  constructor(reason?: string) {
    super("Durable program cancelled");
    this.name = "DurableProgramCancellation";
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

/** Projects thrown unknown values into a safe, serializable application error. */
export function serializeDurableError(error: unknown): SerializedApplicationError {
  if (error instanceof DurableProgramCancellation) {
    return { code: "program_cancelled", message: "Durable program cancelled" };
  }
  if (error instanceof PullApplicationError) {
    return error.applicationError;
  }
  if (error instanceof CrankError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: "program_error", message: "Durable program failed" };
}
