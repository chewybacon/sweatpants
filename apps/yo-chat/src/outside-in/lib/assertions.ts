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

/** Count TOOL_CALL_START events for a tool name. */
export function countToolCalls(transcript: Transcript, toolName: string): number {
  return transcript.events.filter(
    (event) => event.type === "tool_call_start" && event.name === toolName,
  ).length;
}

/** Count elicit events for a key. */
export function countElicits(transcript: Transcript, key: string): number {
  return transcript.events.filter((event) => event.type === "elicit" && event.key === key).length;
}

/** A tool with the given name was invoked (TOOL_CALL_START seen). */
export function expectToolCalled(transcript: Transcript, toolName: string): void {
  if (countToolCalls(transcript, toolName) === 0) {
    fail(transcript, `expected tool "${toolName}" to be called`);
  }
}

/** A tool was invoked at least `minimum` times. */
export function expectToolCallCount(
  transcript: Transcript,
  toolName: string,
  minimum: number,
): void {
  const count = countToolCalls(transcript, toolName);
  if (count < minimum) {
    fail(transcript, `expected tool "${toolName}" to be called >=${minimum} times, saw ${count}`);
  }
}

/** A tool was invoked at most `maximum` times (inclusive). */
export function expectToolCallCountAtMost(
  transcript: Transcript,
  toolName: string,
  maximum: number,
): void {
  const count = countToolCalls(transcript, toolName);
  if (count > maximum) {
    fail(transcript, `expected tool "${toolName}" to be called <=${maximum} times, saw ${count}`);
  }
}

/** An elicit for the given key was emitted. */
export function expectElicit(transcript: Transcript, key: string): void {
  if (countElicits(transcript, key) === 0) {
    fail(transcript, `expected elicit for key "${key}"`);
  }
}

/** An elicit key was emitted at least `minimum` times. */
export function expectElicitCount(transcript: Transcript, key: string, minimum: number): void {
  const count = countElicits(transcript, key);
  if (count < minimum) {
    fail(transcript, `expected elicit "${key}" >=${minimum} times, saw ${count}`);
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

/**
 * Free-form follow-ups must not be rejected by the interrupt gate.
 * Covers the regression: "Open interrupts require resume[]".
 */
export function expectNoOpenInterruptError(transcript: Transcript): void {
  const error = transcript.events.find(
    (event): event is Extract<NormalizedEvent, { type: "run_error" }> =>
      event.type === "run_error" && /Open interrupts require resume/i.test(event.message),
  );
  if (error) {
    fail(transcript, `expected no open-interrupt gate error (got: ${error.message})`);
  }

  // Also catch the same message if it leaked into assistant text.
  if (/Open interrupts require resume/i.test(transcript.text)) {
    fail(transcript, `open-interrupt gate error leaked into assistant text`);
  }
}

/**
 * After a completed interactive tool flow, a free-form follow-up must not
 * re-launch the same tool (history/answer path, not a fresh tool call).
 */
export function expectNoToolRelaunchAfter(
  transcript: Transcript,
  toolName: string,
  completedCallCount: number,
): void {
  const count = countToolCalls(transcript, toolName);
  if (count > completedCallCount) {
    fail(
      transcript,
      `expected no re-launch of "${toolName}" after ${completedCallCount} completed call(s), saw ${count}`,
    );
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

/** Count confirmation tokens across assistant text + tool results. */
export function countConfirmationTokens(
  transcript: Transcript,
  pattern: RegExp = /TKT-[A-Z0-9]+/g,
): number {
  const toolResults = transcript.events
    .filter(
      (event): event is Extract<NormalizedEvent, { type: "tool_call_result" }> =>
        event.type === "tool_call_result",
    )
    .map((event) => event.content)
    .join("\n");
  const haystack = `${transcript.text}\n${toolResults}`;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  return haystack.match(global)?.length ?? 0;
}

/** At least `minimum` booking confirmation tokens appear. */
export function expectConfirmationTokenCount(
  transcript: Transcript,
  minimum: number,
  pattern: RegExp = /TKT-[A-Z0-9]+/g,
): void {
  const count = countConfirmationTokens(transcript, pattern);
  if (count < minimum) {
    fail(transcript, `expected >=${minimum} confirmation token(s), saw ${count}`);
  }
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
