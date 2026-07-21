/**
 * Normalized transcript for the outside-in tier (design R4).
 *
 * The driver parses the raw AG-UI/SSE event stream (both the wire events seen by
 * the real client and the elicit interrupts surfaced into client state) into a
 * flat, order-preserving list of robust, structural facts. Outcome assertions
 * (R6) operate on this transcript rather than on model prose (G5).
 */

export type NormalizedEvent =
  | { type: "run_started" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; callId: string; name: string }
  | { type: "tool_call_args"; callId: string; args: unknown }
  | { type: "tool_call_result"; callId: string; name: string; content: string }
  | {
      type: "elicit";
      key: string;
      callId: string;
      elicitId: string;
      toolName: string;
    }
  | { type: "run_finished" }
  | { type: "run_error"; message: string };

export interface Transcript {
  /** All normalized events in observed order. */
  readonly events: NormalizedEvent[];
  /** Concatenated assistant text across the whole flow. */
  readonly text: string;
  /** Concatenated reasoning/thinking text. */
  readonly reasoning: string;
  /** Terminal outcome of the flow. */
  readonly outcome: "success" | "interrupt" | "error";
}

interface MutableTranscript {
  events: NormalizedEvent[];
  seenElicits: Set<string>;
}

export function createTranscriptCollector(): {
  push: (event: NormalizedEvent) => void;
  /** Record an elicit exactly once (keyed by elicitId). Returns true if new. */
  recordElicit: (e: { key: string; callId: string; elicitId: string; toolName: string }) => boolean;
  build: (outcome: Transcript["outcome"]) => Transcript;
} {
  const state: MutableTranscript = { events: [], seenElicits: new Set() };

  return {
    push(event) {
      state.events.push(event);
    },
    recordElicit(e) {
      if (state.seenElicits.has(e.elicitId)) {
        return false;
      }
      state.seenElicits.add(e.elicitId);
      state.events.push({ type: "elicit", ...e });
      return true;
    },
    build(outcome) {
      let text = "";
      let reasoning = "";
      for (const event of state.events) {
        if (event.type === "text") {
          text += event.delta;
        } else if (event.type === "reasoning") {
          reasoning += event.delta;
        }
      }
      return { events: [...state.events], text, reasoning, outcome };
    },
  };
}

/**
 * Normalize a single raw AG-UI/SSE stream event into a `NormalizedEvent`, or
 * `null` when the event is not one the transcript tracks. Only canonical
 * `SCREAMING_CASE` AG-UI events are accepted.
 */
function stringifyEventContent(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeStreamEvent(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const type = typeof e["type"] === "string" ? (e["type"] as string) : "";

  switch (type) {
    case "RUN_STARTED":
      return { type: "run_started" };

    case "TEXT_MESSAGE_CONTENT":
      return { type: "text", delta: String(e["delta"] ?? "") };

    case "REASONING_MESSAGE_CONTENT":
      return { type: "reasoning", delta: String(e["delta"] ?? "") };

    case "TOOL_CALL_START":
      return {
        type: "tool_call_start",
        callId: String(e["toolCallId"] ?? ""),
        name: String(e["toolCallName"] ?? ""),
      };

    case "TOOL_CALL_ARGS": {
      const delta = e["delta"];
      let args: unknown = delta;
      if (typeof delta === "string") {
        try {
          args = JSON.parse(delta);
        } catch {
          args = delta;
        }
      }
      return { type: "tool_call_args", callId: String(e["toolCallId"] ?? ""), args };
    }

    case "TOOL_CALL_RESULT":
      return {
        type: "tool_call_result",
        callId: String(e["toolCallId"] ?? ""),
        name: String(e["toolCallName"] ?? "unknown"),
        content: stringifyEventContent(e["content"]),
      };

    case "RUN_FINISHED":
      return { type: "run_finished" };

    case "RUN_ERROR":
      return { type: "run_error", message: String(e["message"] ?? "unknown error") };

    default:
      return null;
  }
}
