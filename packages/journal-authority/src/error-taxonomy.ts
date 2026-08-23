/**
 * Single source of truth for public durable-error semantics.
 *
 * Every authority/runtime error code a host or consumer can observe is
 * classified here once, so callers never string-match codes to guess at
 * recovery policy. The decision core's normative rule: protocol outcomes are
 * returned as data; exceptions are reserved for invariant violations.
 */

/** How an error code may present to callers. */
export type ErrorChannel =
  /** Journaled on TaskClosed with an error outcome; drive loops return it as {state:"failed"}. */
  | "task-failure"
  /** Returned as rejection data by the command that refused it. */
  | "command-rejection"
  /** Thrown: caller bug or environment/determinism violation. Not recoverable. */
  | "invariant";

/** What a caller observing the code may do next. */
export type ErrorRecovery =
  /** Program authored something invalid; surface to the user/developer. */
  | "program"
  /** Conditions may change; the identical request can succeed later. */
  | "retryable"
  /** A participant must act before progress resumes. */
  | "await-participant"
  /** Stop driving; state requires orphaning or operator attention. */
  | "stop";

export interface ErrorCodeClassification {
  readonly channel: ErrorChannel;
  readonly recovery: ErrorRecovery;
}

export const PUBLIC_ERROR_CODES: Readonly<Record<string, Readonly<ErrorCodeClassification>>> = {
  // ── Program-authored value refusals (data rejections; surfaced as task failures) ──
  program_error: { channel: "task-failure", recovery: "program" },
  schema_validation_failed: { channel: "task-failure", recovery: "program" },
  payload_too_large: { channel: "task-failure", recovery: "program" },
  record_value_too_large: { channel: "task-failure", recovery: "program" },

  // ── Participant / timing conditions ──
  wait_not_due: { channel: "command-rejection", recovery: "retryable" },

  // ── Determinism and history invariants ──
  nondeterminism_detected: { channel: "invariant", recovery: "stop" },
  history_not_exhausted: { channel: "invariant", recovery: "stop" },
  replay_diverged: { channel: "invariant", recovery: "stop" },
  program_version_mismatch: { channel: "invariant", recovery: "stop" },
  restore_stale: { channel: "invariant", recovery: "stop" },
  stale_activation: { channel: "invariant", recovery: "stop" },
  invalid_resolution_capability: { channel: "invariant", recovery: "stop" },
  proof_error: { channel: "invariant", recovery: "stop" },

  // ── Boundedness policy limits ──
  checkpoint_bound_exceeded: { channel: "invariant", recovery: "stop" },
  emission_quota_exceeded: { channel: "invariant", recovery: "stop" },
};

/** Classify an observed code; unknown codes default to stop-driving. */
export function classifyError(code: string): ErrorCodeClassification {
  return PUBLIC_ERROR_CODES[code] ?? { channel: "invariant", recovery: "stop" };
}
