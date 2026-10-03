import {
  decodePublicHistoryPage,
  type ChatReconnectRequest,
  type ChatTransportRequest,
  type PublicHistoryPage,
} from "@sweatpants/chat-core";
import type {
  ChatRequestBody,
  DurableChatReadRequest,
  DurableHistoryPageRequest,
} from "@sweatpants/durable-chat-runtime/durable-handler";

/** The wire command plus the optional server-supported model/prompt settings. */
export type ChatPostBody = ChatTransportRequest &
  Pick<
    ChatRequestBody,
    | "systemPrompt"
    | "persona"
    | "personaConfig"
    | "enableOptionalTools"
    | "effort"
    | "streamOptions"
    | "initialToolChoice"
    | "model"
  >;

export interface ChatApiInput<Body> {
  body: Body;
  /** Forward caller credentials explicitly; direct calls do not bypass authorization. */
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export type ChatHistoryPageInput = ChatApiInput<{ conversationId: string; cursor: string }>;

export interface ChatApi {
  /** A live HTTP response: consume or cancel its body. No buffering is performed. */
  postChat(input: ChatApiInput<ChatPostBody>): Promise<Response>;
  /** A live HTTP response, including normal not-found/error statuses. */
  readChat(input: ChatApiInput<ChatReconnectRequest>): Promise<Response>;
  pageHistory(input: ChatHistoryPageInput & { asResponse: true }): Promise<Response>;
  pageHistory(input: ChatHistoryPageInput & { asResponse?: false }): Promise<PublicHistoryPage>;
  pageHistory(
    input: ChatHistoryPageInput & { asResponse?: boolean },
  ): Promise<PublicHistoryPage | Response>;
}

/** A failed typed server call. HTTP calls and asResponse calls retain their response. */
export class ChatApiError extends Error {
  override readonly name = "ChatApiError";
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Headers,
  ) {
    super(`Chat API request failed (${status})`);
  }
}

export function normalizeChatBasePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[?#%\\\s]/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    value.includes("//")
  ) {
    throw new TypeError("ChatApp basePath must be an absolute URL path without query or fragment");
  }
  return new URL(value, "http://sweatpants.local").pathname.replace(/\/$/, "");
}

interface BoundEndpoints {
  postChat(request: Request): Promise<Response>;
  readChat(input: DurableChatReadRequest): Promise<Response>;
  pageHistory(input: DurableHistoryPageRequest): Promise<Response>;
}

function routeError(status: number, error: string, allow?: string): Response {
  return Response.json({ error }, { status, ...(allow ? { headers: { Allow: allow } } : {}) });
}

/** HTTP and direct API calls both enter this dispatcher and the same owned endpoints. */
export function createChatRouter(basePath: string, endpoints: BoundEndpoints) {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname.replace(/\/$/, "");
    if (pathname === basePath) {
      return request.method === "POST"
        ? endpoints.postChat(request)
        : routeError(405, "method_not_allowed", "POST");
    }
    if (!pathname.startsWith(`${basePath}/`)) return routeError(404, "not_found");
    const parts = pathname.slice(basePath.length + 1).split("/");
    const history = parts.length === 2 && parts[1] === "history:page";
    if (!parts[0] || (parts.length !== 1 && !history)) return routeError(404, "not_found");
    let conversationId: string;
    try {
      conversationId = decodeURIComponent(parts[0]);
    } catch {
      // Malformed URI input is an observable 400, never an unhandled routing exception.
      return routeError(400, "invalid_conversation_id");
    }
    if (history) {
      return request.method === "POST"
        ? endpoints.pageHistory({ request, conversationId })
        : routeError(405, "method_not_allowed", "POST");
    }
    if (request.method !== "POST" && request.method !== "GET") {
      return routeError(405, "method_not_allowed", "GET, POST");
    }
    const knownWindowToken = request.headers.get("x-known-window-token")?.trim();
    return endpoints.readChat({
      request,
      conversationId,
      ...(knownWindowToken ? { knownWindowToken } : {}),
    });
  };
}

export function createChatApi(
  handler: (request: Request) => Promise<Response>,
  origin: string,
  basePath: string,
): ChatApi {
  const invoke = <T>(path: string, input: ChatApiInput<T>, body: unknown = input.body) => {
    const headers = new Headers(input.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return handler(
      new Request(`${origin}${basePath}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
  };
  // Encode identity as one path segment; reject dot segments that URL would normalize.
  const conversationPath = (id: string): string => {
    if (!id || id === "." || id === "..") throw new TypeError("Invalid conversationId");
    return `/${encodeURIComponent(id)}`;
  };
  async function pageHistory(input: ChatHistoryPageInput & { asResponse: true }): Promise<Response>;
  async function pageHistory(
    input: ChatHistoryPageInput & { asResponse?: false },
  ): Promise<PublicHistoryPage>;
  async function pageHistory(
    input: ChatHistoryPageInput & { asResponse?: boolean },
  ): Promise<PublicHistoryPage | Response>;
  async function pageHistory(
    input: ChatHistoryPageInput & { asResponse?: boolean },
  ): Promise<PublicHistoryPage | Response> {
    const response = await invoke(
      `${conversationPath(input.body.conversationId)}/history:page`,
      input,
      { cursor: input.body.cursor },
    );
    if (input.asResponse) return response;
    const body: unknown = await response.json();
    if (!response.ok) throw new ChatApiError(response.status, body, response.headers);
    return decodePublicHistoryPage(body);
  }
  return {
    postChat: (input) => invoke("", input),
    readChat: (input) => invoke(conversationPath(input.body.conversationId), input),
    pageHistory,
  };
}
