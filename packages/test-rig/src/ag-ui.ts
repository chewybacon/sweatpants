import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";

export type AgUiEvent = AGUIEvent;

export interface AgUiFrame {
  readonly lsn?: number;
  readonly event: AgUiEvent;
}

const deprecatedEventTypes = new Set([
  "THINKING_START",
  "THINKING_END",
  "THINKING_TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_END",
]);

const legacyEventTypes = new Set([
  "ag_ui_checkpoint",
  "ag_ui_state_snapshot",
  "ag_ui_messages_snapshot",
  "ag_ui_tool_call_result",
  "ag_ui_tool_call_error",
  "elicit_request",
  "conversation_state",
  "session_info",
]);

interface EventWaiter {
  readonly type: string;
  readonly after: number;
  readonly resolve: (event: AgUiEvent) => void;
  readonly reject: (error: unknown) => void;
}

export interface AgUiConformanceOptions {
  readonly after?: number;
  readonly lifecycle?: boolean;
}

export interface AgUiProbe {
  mark(): number;
  events(after?: number): readonly AgUiEvent[];
  frames(after?: number): readonly AgUiFrame[];
  expectEvent(type: string, options?: { after?: number }): Promise<AgUiEvent>;
  assertConformant(options?: AgUiConformanceOptions): void;
  observe(response: Response): Response;
  /** Records replay/hydration frames without mixing them into live run lifecycle events. */
  observeReplay(response: Response): Response;
  settle(): Promise<void>;
  close(error?: unknown): void;
}

function frameFromJson(value: unknown): AgUiFrame | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate =
    record["type"] === undefined && typeof record["event"] === "object" && record["event"] !== null
      ? record["event"]
      : record;
  const type = (candidate as Record<string, unknown>)["type"];
  if (typeof type !== "string") {
    return undefined;
  }
  if (legacyEventTypes.has(type) || type.startsWith("ag_ui_")) {
    throw new Error(`Obsolete AG-UI event emitted: ${type}`);
  }
  // Durable stream transports may carry lower-case control records alongside
  // public AG-UI events. They are transport evidence, not AG-UI events.
  if (type !== type.toUpperCase()) {
    return undefined;
  }
  if (deprecatedEventTypes.has(type)) {
    throw new Error(`Deprecated AG-UI event emitted: ${type}`);
  }
  const parsed = EventSchemas.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Invalid AG-UI event ${JSON.stringify(type)} ${JSON.stringify(candidate).slice(0, 1000)}: ${parsed.error.message}`,
    );
  }
  const event = parsed.data;
  if (!event) {
    return undefined;
  }
  const lsn =
    typeof record["lsn"] === "number" && Number.isSafeInteger(record["lsn"]) && record["lsn"] >= 0
      ? record["lsn"]
      : undefined;
  return { ...(lsn === undefined ? {} : { lsn }), event };
}

function assertLifecycle(events: readonly AgUiEvent[]): void {
  if (events.length === 0) {
    throw new Error("AG-UI conformance observed no events");
  }
  const text = new Set<string>();
  const calls = new Set<string>();
  let runActive = false;
  let terminal = false;

  for (const event of events) {
    const snapshotPrelude =
      event.type === EventType.MESSAGES_SNAPSHOT ||
      event.type === EventType.STATE_SNAPSHOT ||
      event.type === EventType.ACTIVITY_SNAPSHOT;
    if (terminal && event.type !== EventType.RUN_STARTED && !snapshotPrelude) {
      throw new Error(`AG-UI event after terminal event: ${event.type}`);
    }
    switch (event.type) {
      case EventType.MESSAGES_SNAPSHOT:
        if (runActive) {
          throw new Error("MESSAGES_SNAPSHOT must precede RUN_STARTED for its response segment");
        }
        break;
      case EventType.RUN_STARTED:
        runActive = true;
        terminal = false;
        break;
      case EventType.TEXT_MESSAGE_START:
        text.add(String(event["messageId"]));
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_END: {
        const id = String(event["messageId"]);
        if (!text.has(id)) {
          throw new Error(`${event.type} without TEXT_MESSAGE_START: ${id}`);
        }
        if (event.type === EventType.TEXT_MESSAGE_END) {
          text.delete(id);
        }
        break;
      }
      case EventType.TOOL_CALL_START:
        calls.add(String(event["toolCallId"]));
        break;
      case EventType.TOOL_CALL_ARGS: {
        const id = String(event["toolCallId"]);
        if (!calls.has(id)) {
          throw new Error(`TOOL_CALL_ARGS without TOOL_CALL_START: ${id}`);
        }
        break;
      }
      case EventType.TOOL_CALL_END: {
        const id = String(event["toolCallId"]);
        if (!calls.delete(id)) {
          throw new Error(`TOOL_CALL_END without TOOL_CALL_START: ${id}`);
        }
        break;
      }
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        if (!runActive) {
          throw new Error(`${event.type} without RUN_STARTED`);
        }
        if (text.size > 0 || calls.size > 0) {
          throw new Error(`${event.type} with active message/tool lifecycle`);
        }
        runActive = false;
        terminal = true;
        break;
    }
  }
  if (!terminal) {
    throw new Error("AG-UI run did not emit a terminal event");
  }
}

export function createAgUiProbe(onError: (error: Error) => void): AgUiProbe {
  const events: AgUiEvent[] = [];
  const frames: AgUiFrame[] = [];
  const waiters: EventWaiter[] = [];
  let failure: Error | undefined;
  let closed = false;

  const fail = (cause: unknown): Error => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!failure) {
      failure = error;
      onError(error);
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    }
    return failure;
  };

  const publish = (value: unknown, includeEvent = true): void => {
    const frame = frameFromJson(value);
    if (!frame) {
      return;
    }
    frames.push(frame);
    if (!includeEvent) {
      return;
    }
    const index = events.push(frame.event) - 1;
    for (const waiter of [...waiters]) {
      if (index < waiter.after || String(frame.event.type) !== waiter.type) {
        continue;
      }
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame.event);
    }
  };

  const observedResponse = (response: Response, includeEvent = true): Response => {
    if (!response.body) {
      return response;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("ndjson") && !contentType.includes("event-stream")) {
      return response;
    }

    const decoder = new TextDecoder();
    const delimiter = contentType.includes("event-stream") ? "\n\n" : "\n";
    let buffer = "";
    const drain = (flush: boolean): void => {
      while (buffer.includes(delimiter)) {
        const boundary = buffer.indexOf(delimiter);
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimiter.length);
        const payload = contentType.includes("event-stream")
          ? frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
          : frame.trim();
        if (payload) {
          publish(JSON.parse(payload), includeEvent);
        }
      }
      const trailing = buffer.trim();
      if (flush && trailing && !contentType.includes("event-stream")) {
        publish(JSON.parse(trailing), includeEvent);
        buffer = "";
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            buffer += decoder.decode(chunk, { stream: true });
            drain(false);
            controller.enqueue(chunk);
          } catch (error) {
            throw fail(error);
          }
        },
        flush() {
          try {
            buffer += decoder.decode();
            drain(true);
          } catch (error) {
            throw fail(error);
          }
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    mark: () => events.length,
    events: (after = 0) => Object.freeze(events.slice(after)),
    frames: (after = 0) => Object.freeze(frames.slice(after)),
    expectEvent(type, options = {}) {
      if (failure) {
        return Promise.reject(failure);
      }
      const after = options.after ?? 0;
      const existing = events.slice(after).find((event) => String(event.type) === type);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<AgUiEvent>((resolve, reject) => {
        waiters.push({ type, after, resolve, reject });
      });
    },
    assertConformant(options = {}) {
      if (failure) {
        throw failure;
      }
      const selected = events.slice(options.after ?? 0);
      for (const event of selected) {
        EventSchemas.parse(event);
      }
      if (options.lifecycle !== false) {
        assertLifecycle(selected);
      }
    },
    observe(response) {
      if (closed) {
        return response;
      }
      return observedResponse(response, true);
    },
    observeReplay(response) {
      if (closed) {
        return response;
      }
      return observedResponse(response, false);
    },
    async settle() {
      if (failure) {
        throw failure;
      }
    },
    close(error) {
      closed = true;
      const cause = error ?? new Error("AG-UI probe closed");
      for (const waiter of waiters.splice(0)) {
        waiter.reject(cause);
      }
    },
  };
}
