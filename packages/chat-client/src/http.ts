import { call, ensure, resource, type Operation, type Stream } from "effection";
import {
  decodeConversationStreamEvent,
  decodePublicHistoryPage,
  type ChatReconnectRequest,
  type ChatTransportRequest,
  type ConversationStreamEvent,
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

function joinUrl(api: string, conversationId?: string, clientId?: string): string {
  const url = new URL(api, "http://sweatpants.invalid");
  if (conversationId !== undefined) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(conversationId)}`;
  }
  if (clientId !== undefined) {
    url.searchParams.set("clientId", clientId);
  }
  if (url.origin === "http://sweatpants.invalid") {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

function responseError(response: Response): Operation<never> {
  return (function* (): Operation<never> {
    let detail = `Chat API error: ${response.status}`;
    let errorCode = "chat_transport_failed";
    try {
      const text = yield* call(() => response.text());
      if (text) {
        try {
          const value = JSON.parse(text) as { error?: unknown };
          if (typeof value.error === "string") {
            detail = value.error;
            if (
              new Set([
                "public_history_cursor_invalid",
                "public_history_cursor_expired",
                "public_history_frontier_changed",
                "public_root_conflict",
                "public_history_parent_missing",
              ]).has(value.error)
            ) {
              errorCode = value.error;
            }
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
    throw new ChatClientError(errorCode, detail);
  })();
}

function parseLine(line: string): ConversationStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return decodeConversationStreamEvent(value);
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

function parseSseBlock(block: string): ConversationStreamEvent | undefined {
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
    return decodeConversationStreamEvent(value);
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
): Stream<ConversationStreamEvent, void> {
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
      *next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
        while (true) {
          if (signal.aborted) {
            return { done: true, value: undefined };
          }
          const delimiter = sse ? /\r?\n\r?\n/ : /\r?\n/;
          const match = delimiter.exec(buffer);
          if (match) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const event = sse ? parseSseBlock(block) : parseLine(block);
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
            const event = parseSseBlock(remaining);
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
): Stream<ConversationStreamEvent, void> {
  if (!response.body) {
    throw new ChatClientError("chat_transport_failed", "Chat API response has no body");
  }
  return parseChatResponseStream(
    response.body,
    signal,
    response.headers.get("content-type") ?? "application/x-ndjson",
  );
}

function fetchInit(options: HttpTransportOptions, signal: AbortSignal, body?: string): RequestInit {
  return {
    ...options.requestInit,
    method: "POST",
    headers: requestHeaders(options),
    signal,
    credentials: options.credentials,
    body,
  };
}

export function createHttpTransport(options: HttpTransportOptions = {}): ChatTransportContract {
  const api = options.api ?? "/api/chat";
  const chatFetch = options.fetch ?? globalThis.fetch;
  if (!chatFetch) {
    throw new ChatClientError("chat_transport_unavailable", "No fetch implementation is available");
  }

  return {
    *sendMessages(
      request: ChatTransportRequest,
      signal: AbortSignal,
    ): Operation<Stream<ConversationStreamEvent, void>> {
      const body = JSON.stringify(request);
      const response = yield* call(() => chatFetch(api, fetchInit(options, signal, body)));
      if (!response.ok) {
        return yield* responseError(response);
      }
      return responseStream(response, signal);
    },

    *reconnectToStream(
      request: ChatReconnectRequest,
      signal: AbortSignal,
    ): Operation<Stream<ConversationStreamEvent, void> | null> {
      const url = joinUrl(api, request.conversationId, request.clientId);
      const body = JSON.stringify(request);
      const headers = requestHeaders(options);
      headers.delete("Content-Type");
      const response = yield* call(() =>
        chatFetch(url, {
          ...options.requestInit,
          method: "POST",
          headers,
          body,
          signal,
          credentials: options.credentials,
        }),
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        return yield* responseError(response);
      }
      return responseStream(response, signal);
    },

    *loadHistoryPage(conversationId, cursor, signal) {
      const base = api.endsWith("/") ? api.slice(0, -1) : api;
      const url = `${base}/${encodeURIComponent(conversationId)}/history:page`;
      const response = yield* call(() =>
        chatFetch(url, fetchInit(options, signal, JSON.stringify({ cursor }))),
      );
      if (!response.ok) {
        return yield* responseError(response);
      }
      const value: unknown = yield* call(() => response.json());
      return decodePublicHistoryPage(value);
    },

    *disconnect(_reason?: string): Operation<void> {
      return;
    },
  };
}
