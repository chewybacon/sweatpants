/** Canonical JSON value accepted across durable process and persistence boundaries. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Safe error DTO permitted in journals and public runtime results. */
export type SerializedApplicationError = { code: string; message: string; details?: Json };

/** Runtime and boundary error code. Public command algebras define narrower unions where needed. */
export type RuntimeErrorCode = string;

/** A safely serializable runtime or boundary failure. */
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
