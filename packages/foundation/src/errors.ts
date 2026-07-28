import type { Json } from "./json.ts";
export type RuntimeErrorCode = string;
export type SerializedApplicationError = { code: string; message: string; details?: Json };
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
export class PullApplicationError extends Error {
  readonly _tag = "PullApplicationError";
  constructor(readonly applicationError: SerializedApplicationError) {
    super(applicationError.message);
    this.name = "PullApplicationError";
  }
}
