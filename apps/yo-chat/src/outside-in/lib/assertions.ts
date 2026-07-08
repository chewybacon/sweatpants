/**
 * Outcome assertion helpers over the normalized transcript (design R6/G5).
 *
 * These assert on robust, structural facts from the AG-UI/SSE stream — tool
 * calls, elicit keys, confirmation tokens, terminal states — never on model
 * prose. They throw `Error` with a diagnostic transcript summary on failure so
 * they compose with any test runner.
 */
import { AssertionFailure } from "./flake.ts";
import type { NormalizedEvent, Transcript } from "./transcript.ts";

function summarize(transcript: Transcript): string {
  const kinds = transcript.events.map((event) => {
    switch (event.type) {
      case "tool_call_start":
        return `tool_call_start(${event.name})`;
      case "tool_call_result":
        return `tool_call_result(${event.name})`;
      case "elicit":
        return `elicit(${event.key})`;
      default:
        return event.type;
    }
  });
  return `outcome=${transcript.outcome} events=[${kinds.join(", ")}]`;
}

function fail(transcript: Transcript, message: string): never {
  throw new AssertionFailure(`${message}\n  ${summarize(transcript)}`);
}

/** A tool with the given name was invoked (TOOL_CALL_START seen). */
export function expectToolCalled(transcript: Transcript, toolName: string): void {
  const called = transcript.events.some(
    (event) => event.type === "tool_call_start" && event.name === toolName,
  );
  if (!called) {
    fail(transcript, `expected tool "${toolName}" to be called`);
  }
}

/** An elicit for the given key was emitted. */
export function expectElicit(transcript: Transcript, key: string): void {
  const emitted = transcript.events.some((event) => event.type === "elicit" && event.key === key);
  if (!emitted) {
    fail(transcript, `expected elicit for key "${key}"`);
  }
}

/** At least one RUN_FINISHED event was emitted for the flow. */
export function expectRunFinished(transcript: Transcript, minimumCount = 1): void {
  const count = transcript.events.filter((event) => event.type === "run_finished").length;
  if (count < minimumCount) {
    fail(transcript, `expected >=${minimumCount} RUN_FINISHED event(s), saw ${count}`);
  }
}

/** The flow reached a terminal state matching `outcome`. */
export function expectOutcome(transcript: Transcript, outcome: Transcript["outcome"]): void {
  if (transcript.outcome !== outcome) {
    fail(transcript, `expected terminal outcome "${outcome}"`);
  }
}

/** No RUN_ERROR was emitted anywhere in the flow. */
export function expectNoRunError(transcript: Transcript): void {
  const error = transcript.events.find(
    (event): event is Extract<NormalizedEvent, { type: "run_error" }> => event.type === "run_error",
  );
  if (error) {
    fail(transcript, `expected no RUN_ERROR (got: ${error.message})`);
  }
}

/** Final assistant text (or any tool result content) matches `pattern`. */
export function expectFinalTextMatches(transcript: Transcript, pattern: RegExp): void {
  if (pattern.test(transcript.text)) {
    return;
  }
  const toolResults = transcript.events
    .filter(
      (event): event is Extract<NormalizedEvent, { type: "tool_call_result" }> =>
        event.type === "tool_call_result",
    )
    .map((event) => event.content)
    .join("\n");
  if (pattern.test(toolResults)) {
    return;
  }
  fail(transcript, `expected text to match ${pattern}`);
}

/**
 * A booking-style confirmation token (`TKT-XXXX`) appears in assistant text or a
 * tool result. Mirrors the outcome-based success key used by the existing e2e
 * `book-flight-full.spec.ts`.
 */
export function expectConfirmationToken(
  transcript: Transcript,
  pattern: RegExp = /TKT-[A-Z0-9]+/,
): void {
  expectFinalTextMatches(transcript, pattern);
}

function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function toolResultCandidates(content: string): unknown[] {
  const parsed = tryParseJson(content);
  const candidates: unknown[] = [parsed];
  const values = Array.isArray(parsed) ? parsed : [parsed];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "result"]) {
      const nested = record[key];
      if (typeof nested === "string") {
        candidates.push(tryParseJson(nested));
      } else if (nested !== undefined) {
        candidates.push(nested);
      }
    }
  }
  return candidates;
}

/** A tool result payload satisfies a structural predicate. */
export function expectToolResultJson(
  transcript: Transcript,
  toolName: string,
  predicate: (value: unknown) => boolean,
  description: string,
): void {
  const results = transcript.events.filter(
    (event): event is Extract<NormalizedEvent, { type: "tool_call_result" }> =>
      event.type === "tool_call_result" && (event.name === toolName || event.name === "unknown"),
  );
  for (const result of results) {
    for (const candidate of toolResultCandidates(result.content)) {
      if (predicate(candidate)) {
        return;
      }
    }
  }
  fail(transcript, `expected ${toolName} tool result to satisfy: ${description}`);
}

/** The tic-tac-toe tool returned a real terminal game result and final board. */
export function expectTerminalTicTacToeResult(
  transcript: Transcript,
  toolName: "play_ttt" | "tictactoe" = "play_ttt",
): void {
  expectToolResultJson(
    transcript,
    toolName,
    (value): boolean => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const result = value as Record<string, unknown>;
      return (
        result["success"] === true &&
        ["model_wins", "user_wins", "draw"].includes(String(result["result"])) &&
        Array.isArray(result["board"]) &&
        result["board"].length === 9 &&
        typeof result["boardDisplay"] === "string"
      );
    },
    "success=true with result, 9-cell final board, and boardDisplay",
  );
}
