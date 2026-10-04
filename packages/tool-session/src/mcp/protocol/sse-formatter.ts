/** Request-scoped MCP SSE encoding. Transport sessions and replay IDs are not supported. */
import type { SseEvent } from "./types.ts";

export function formatSseEvent(event: SseEvent): string {
  const lines: string[] = [];

  // Event ID (for resumability)
  if (event.id !== undefined) {
    lines.push(`id: ${event.id}`);
  }

  // Event type (if not default 'message')
  if (event.event !== undefined) {
    lines.push(`event: ${event.event}`);
  }

  // Retry interval
  if (event.retry !== undefined) {
    lines.push(`retry: ${event.retry}`);
  }

  // Data - split multi-line data into separate data: lines
  const dataLines = event.data.split("\n");
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }

  // End with double newline
  return lines.join("\n") + "\n\n";
}

/**
 * Format a JSON-RPC message as an SSE event.
 */
export function formatMessageAsSse(message: unknown, eventType = "message"): string {
  return formatSseEvent({ event: eventType, data: JSON.stringify(message) });
}

// =============================================================================
// SSE PARSER (for testing/client use)
// =============================================================================

/**
 * Parse an SSE event from a string.
 *
 * @param raw - Raw SSE event string (including trailing \n\n)
 * @returns Parsed event, or null if invalid
 */
export function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split("\n");
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("retry:")) {
      const retryStr = line.slice(6).trim();
      const parsed = parseInt(retryStr, 10);
      if (!isNaN(parsed)) {
        retry = parsed;
      }
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
    // Skip empty lines and comments (lines starting with :)
  }

  // Must have at least one data line
  if (dataLines.length === 0) {
    return null;
  }

  const result: SseEvent = {
    data: dataLines.join("\n"),
  };

  if (id !== undefined) {
    result.id = id;
  }
  if (event !== undefined) {
    result.event = event;
  }
  if (retry !== undefined) {
    result.retry = retry;
  }

  return result;
}

/**
 * Parse multiple SSE events from a stream chunk.
 *
 * @param chunk - Raw chunk containing one or more SSE events
 * @returns Array of parsed events and any remaining incomplete data
 */
export function parseSseChunk(chunk: string): { events: SseEvent[]; remaining: string } {
  const events: SseEvent[] = [];
  const parts = chunk.split("\n\n");

  // Last part might be incomplete
  const remaining = parts.pop() ?? "";

  for (const part of parts) {
    if (part.trim() === "") {
      continue;
    }
    const event = parseSseEvent(part + "\n\n");
    if (event) {
      events.push(event);
    }
  }

  return { events, remaining };
}

// =============================================================================
// SSE STREAM HELPERS
// =============================================================================

/**
 * Create an SSE stream headers object.
 */
export function createSseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  };
}
