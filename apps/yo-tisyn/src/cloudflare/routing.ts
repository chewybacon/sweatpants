import { createChatRouter } from "@sweatpants/agent-host/server";
import { readBoundedChatRequest } from "@sweatpants/durable-chat-runtime/durable-handler";
import { CrankError } from "@sweatpants/durable-execution";
import { run } from "effection";

export interface ConversationNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

/** Match yo-chat's conversation placement. Agent Host still owns API semantics. */
export function createConversationRouter(conversations: ConversationNamespace) {
  const forward = (request: Request, id: string) => conversations.getByName(id).fetch(request);
  return createChatRouter("/api/chat", {
    async postChat(request) {
      let body: unknown;
      try {
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
