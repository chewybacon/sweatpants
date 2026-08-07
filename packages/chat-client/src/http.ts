import { call, ensure, resource, type Operation, type Stream } from "effection";
import {
  decodeAGUIEvent,
  type ChatReconnectRequest,
  type ChatTransportRequest,
  type AGUIEvent,
  type ChatTransportContract,
} from "@sweatpants/chat-core";
import { ChatClientError } from "./errors.ts";

export type ChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  readonly api?: string;
  readonly fetch?: ChatFetch;
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  readonly requestInit?: Omit<
    RequestInit,
    "body" | "method" | "signal" | "headers" | "credentials"
  >;
}

function joinUrl(api: string, threadId?: string, cursor?: number, clientId?: string): string {
  const url = new URL(api, "http://sweatpants.invalid");
  if (threadId !== undefined) {
    // The durable handler's query name remains conversationId; the public
    // client identity is threadId and the POST body carries both protocol
    // aliases while the server migration is still in place.
    url.searchParams.set("conversationId", threadId);
  }
  if (clientId !== undefined) {
    url.searchParams.set("clientId", clientId);
  }
  if (cursor !== undefined) {
    url.searchParams.set("offset", String(cursor));
  }
  if (url.origin === "http://sweatpants.invalid") {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

function responseError(response: Response): Operation<never> {
  return (function* (): Operation<never> {
    let detail = `Chat API error: ${response.status}`;
    try {
      const text = yield* call(() => response.text());
      if (text) {
        try {
          const value = JSON.parse(text) as { error?: unknown };
          if (typeof value.error === "string") {
            detail = value.error;
          } else {
            detail += ` - ${text}`;
          }
        } catch {
          detail += ` - ${text}`;
        }
      }
    } catch {
      // The status is still a useful coded client failure.
    }
    throw new ChatClientError("chat_transport_failed", detail);
  })();
}

function parseLine(line: string, onCursor?: (cursor: number) => void): AGUIEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const cursor = (value as Record<string, unknown>)["lsn"];
      if (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0) {
        onCursor?.(cursor);
      }
    }
    return decodeAGUIEvent(value);
  } catch (error) {
    if (error instanceof ChatClientError) {
      throw error;
    }
    const code = (error as { code?: unknown }).code;
    throw new ChatClientError(
      typeof code === "string" ? code : "chat_event_invalid",
      "Invalid serialized AG-UI event",
      error,
    );
  }
}

function parseSseBlock(block: string, onCursor?: (cursor: number) => void): AGUIEvent | undefined {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  const payload = data.join("\n");
  if (payload === "[DONE]") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(payload);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const cursor = (value as Record<string, unknown>)["lsn"];
      if (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0) {
        onCursor?.(cursor);
      }
    }
    return decodeAGUIEvent(value);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new ChatClientError(
      typeof code === "string" ? code : "chat_event_invalid",
      "Invalid serialized AG-UI SSE event",
      error,
    );
  }
}

/** Parse NDJSON/SSE once at the transport serialization boundary. */
export function parseChatResponseStream(
  readable: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  contentType = "application/x-ndjson",
  onCursor?: (cursor: number) => void,
): Stream<AGUIEvent, void> {
  const sse = contentType.includes("text/event-stream");
  return resource(function* (provide) {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    yield* ensure(function* () {
      if (!done) {
        done = true;
        yield* call(() => reader.cancel());
      }
    });

    yield* provide({
      *next(): Operation<IteratorResult<AGUIEvent, void>> {
        while (true) {
          if (signal.aborted) {
            return { done: true, value: undefined };
          }
          const delimiter = sse ? /\r?\n\r?\n/ : /\r?\n/;
          const match = delimiter.exec(buffer);
          if (match) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const event = sse ? parseSseBlock(block, onCursor) : parseLine(block, onCursor);
            if (event) {
              return { done: false, value: event };
            }
            continue;
          }

          const chunk = yield* call(() => reader.read());
          if (!chunk.done) {
            buffer += decoder.decode(chunk.value, { stream: true });
            continue;
          }
          buffer += decoder.decode();
          done = true;
          const remaining = buffer.trim();
          buffer = "";
          if (!remaining) {
            return { done: true, value: undefined };
          }
          if (signal.aborted) {
            return { done: true, value: undefined };
          }
          if (sse) {
            const event = parseSseBlock(remaining, onCursor);
            if (event) {
              return { done: false, value: event };
            }
            return { done: true, value: undefined };
          }
          throw new ChatClientError(
            "chat_transport_truncated",
            "NDJSON response ended with an unterminated frame",
          );
        }
      },
    });
  });
}

function requestHeaders(options: HttpTransportOptions): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/x-ndjson, text/event-stream");
  return headers;
}

function responseStream(
  response: Response,
  signal: AbortSignal,
  onCursor?: (cursor: number) => void,
): Stream<AGUIEvent, void> {
  if (!response.body) {
    throw new ChatClientError("chat_transport_failed", "Chat API response has no body");
  }
  return parseChatResponseStream(
    response.body,
    signal,
    response.headers.get("content-type") ?? "application/x-ndjson",
    onCursor,
  );
}

function fetchInit(options: HttpTransportOptions, signal: AbortSignal, body?: string): RequestInit {
  return {
    ...options.requestInit,
    method: "POST",
    headers: requestHeaders(options),
    signal,
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

export function createHttpTransport(options: HttpTransportOptions = {}): ChatTransportContract {
  const api = options.api ?? "/api/chat";
  const chatFetch = options.fetch ?? globalThis.fetch;
  const cursors = new Map<string, number>();
  const recordCursor = (threadId: string, cursor: number): void => {
    const previous = cursors.get(threadId);
    if (previous === undefined || cursor > previous) {
      cursors.set(threadId, cursor);
    }
  };
  if (!chatFetch) {
    throw new ChatClientError("chat_transport_unavailable", "No fetch implementation is available");
  }

  return {
    *sendMessages(
      request: ChatTransportRequest,
      signal: AbortSignal,
    ): Operation<Stream<AGUIEvent, void>> {
      const body = JSON.stringify({
        input: request.input,
        trigger: request.trigger,
        clientId: request.clientId,
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
        ...(request.cancellationReason === undefined
          ? {}
          : { pluginAbort: { reason: request.cancellationReason } }),
      });
      const response = yield* call(() => chatFetch(api, fetchInit(options, signal, body)));
      if (!response.ok) {
        return yield* responseError(response);
      }
      return responseStream(response, signal, (nextCursor) => {
        recordCursor(request.input.threadId, nextCursor);
      });
    },

    *reconnectToStream(
      request: ChatReconnectRequest,
      signal: AbortSignal,
    ): Operation<Stream<AGUIEvent, void> | null> {
      const url = joinUrl(
        api,
        request.threadId,
        request.cursor ?? cursors.get(request.threadId),
        request.clientId,
      );
      const headers = requestHeaders(options);
      headers.delete("Content-Type");
      const response = yield* call(() =>
        chatFetch(url, {
          ...options.requestInit,
          method: "GET",
          headers,
          signal,
          ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
        }),
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        return yield* responseError(response);
      }
      return responseStream(response, signal, (nextCursor) => {
        recordCursor(request.threadId, nextCursor);
      });
    },

    *disconnect(_reason?: string): Operation<void> {
      return;
    },
  };
}
