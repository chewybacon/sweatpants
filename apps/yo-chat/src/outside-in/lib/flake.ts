/**
 * Bounded flake policy for real-model flows (design R10/C1).
 *
 * Real cloud models are nondeterministic and providers throw transient
 * network/rate-limit errors. This policy retries a flow a small, bounded number
 * of times on TRANSIENT errors only — never on assertion failures (those are
 * real regressions) and never by faking outcomes.
 *
 * A per-flow timeout bounds each attempt; the driver enforces its own deadline,
 * and this wrapper adds a hard ceiling so a wedged attempt cannot hang the run.
 */

export interface FlakePolicy {
  /** Total attempts including the first (design suggests up to 2). */
  attempts: number;
  /** Hard per-attempt timeout in ms. */
  timeoutMs: number;
}

export const DEFAULT_FLAKE_POLICY: FlakePolicy = {
  attempts: Number.parseInt(process.env["OUTSIDE_IN_ATTEMPTS"] ?? "2", 10),
  timeoutMs: Number.parseInt(process.env["OUTSIDE_IN_TIMEOUT_MS"] ?? "100000", 10),
};

/** Assertion failures must NOT be retried — only transient infra errors are. */
export class AssertionFailure extends Error {
  override name = "AssertionFailure";
}

const TRANSIENT_PATTERNS = [
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /^Connection error\.?$/i,
  /^Request timed out\.?$/i,
  /\bfetch failed\b/i,
  /\bnetwork\b/i,
  /\brate.?limit/i,
  /\b429\b/,
  /\b5\d\d\b/, // 5xx
  /socket hang up/i,
];

export function isTransientError(error: unknown): boolean {
  if (error instanceof AssertionFailure) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`flow attempt timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
        return undefined;
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
        return undefined;
      },
    );
  });
}

/**
 * Run `attempt` under the flake policy. Retries only on transient errors up to
 * `policy.attempts`; re-throws assertion failures immediately.
 */
export async function withFlakePolicy<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  policy: FlakePolicy = DEFAULT_FLAKE_POLICY,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < Math.max(1, policy.attempts); i++) {
    try {
      return await withTimeout(attempt(i), policy.timeoutMs);
    } catch (error) {
      lastError = error;
      if (error instanceof AssertionFailure) {
        throw error;
      }
      if (!isTransientError(error) || i === policy.attempts - 1) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[outside-in] transient error on attempt ${i + 1}/${policy.attempts}; retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  throw lastError;
}
