import {
  decodePublicHistoryPage,
  type ChatReconnectRequest,
  type ChatTransportRequest,
  type PublicHistoryPage,
} from "@sweatpants/chat-core";
import type { ChatRequestBody } from "@sweatpants/durable-chat-runtime/durable-handler";
import type { BoundChatEndpoints } from "./chat-endpoints.ts";

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

export function createChatApi(
  endpoints: BoundChatEndpoints,
  origin: string,
  basePath: string,
): ChatApi {
  const requestFor = <T>(path: string, input: ChatApiInput<T>, body: unknown = input.body) => {
    const headers = new Headers(input.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return new Request(`${origin}${basePath}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
  };
  // Encode identity as one path segment; reject dot segments that URL would normalize.
  const conversationPath = (id: string): string => {
    if (!id || id === "." || id === "..") {
      throw new TypeError("Invalid conversationId");
    }
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
    const response = await endpoints.pageHistory({
      request: requestFor(`${conversationPath(input.body.conversationId)}/history:page`, input, {
        cursor: input.body.cursor,
      }),
      conversationId: input.body.conversationId,
    });
    if (input.asResponse) {
      return response;
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new ChatApiError(response.status, body, response.headers);
    }
    return decodePublicHistoryPage(body);
  }
  return {
    postChat: (input) => endpoints.postChat(requestFor("", input)),
    readChat: (input) => {
      const request = requestFor(conversationPath(input.body.conversationId), input);
      const knownWindowToken = request.headers.get("x-known-window-token")?.trim();
      return endpoints.readChat({
        request,
        conversationId: input.body.conversationId,
        knownWindowToken: knownWindowToken || undefined,
      });
    },
    pageHistory,
  };
}
