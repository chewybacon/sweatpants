import { createChatRouter } from "@sweatpants/agent-host/server";
import { readBoundedChatRequest } from "@sweatpants/durable-chat-runtime/durable-handler";
import { CrankError } from "@sweatpants/durable-execution";
import { run } from "effection";

export type ChatHostPlacement = "worker" | "durable-object";

export interface ConversationNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

export function chatHostPlacement(value: string | undefined): ChatHostPlacement {
  if (value === undefined || value === "worker") {
    return "worker";
  }
  if (value === "durable-object") {
    return value;
  }
  throw new Error(`Invalid CHAT_HOST_PLACEMENT: ${value}`);
}

/** Only routing runs at ingress; the selected host owns the response stream. */
export function createCloudflareChatRouter(options: {
  placement: ChatHostPlacement;
  conversations: ConversationNamespace;
  worker: (request: Request) => Promise<Response>;
}) {
  if (options.placement === "worker") {
    return options.worker;
  }
  function forward(request: Request, conversationId: string): Promise<Response> {
    // yo-chat is a single-tenant demo. An authenticated deployment must include
    // its trusted tenant identity here, never a caller-supplied tenant header.
    return options.conversations.getByName(conversationId).fetch(request);
  }
  return createChatRouter("/api/chat", {
    async postChat(request) {
      let body: unknown;
      try {
        // Inspect only the bounded routing envelope. Domain admission stays in
        // the selected host. Do not tee the body: cancellation of an oversized
        // tee would wait on its unread forwarding branch.
        body = await run(() => readBoundedChatRequest(request));
      } catch (error) {
        if (!(error instanceof CrankError)) {
          throw error;
        }
        return Response.json(
          { error: error.code },
          {
            status: error.code === "payload_too_large" ? 413 : 400,
          },
        );
      }
      const id =
        body && typeof body === "object" && "conversationId" in body
          ? body.conversationId
          : undefined;
      if (typeof id !== "string" || !id.trim() || id.length > 512) {
        return Response.json({ error: "invalid_conversation_id" }, { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return forward(
        new Request(request.url, {
          method: request.method,
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        }),
        id.trim(),
      );
    },
    readChat: ({ request, conversationId }) => forward(request, conversationId),
    pageHistory: ({ request, conversationId }) => forward(request, conversationId),
  });
}
