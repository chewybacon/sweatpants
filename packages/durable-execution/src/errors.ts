import type { Json, SerializedApplicationError } from "@sweatpants/foundation";

/** Runtime and durable-boundary error code. Public algebras define narrower unions. */
export type RuntimeErrorCode = string;

/** One canonical durable runtime error identity across every adapter and Host. */
export class CrankError extends Error {
  readonly _tag = "CrankError";

  constructor(
    readonly code: RuntimeErrorCode,
    message = code,
    readonly details?: Json,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CrankError";
  }
}

/** Carries an expected application failure returned by a durable pull. */
export class PullApplicationError extends Error {
  readonly _tag = "PullApplicationError";

  constructor(readonly applicationError: SerializedApplicationError) {
    super(applicationError.message);
    this.name = "PullApplicationError";
  }
}
