import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export function reconnectNativeChat(request: Request, conversationId: string): Promise<Response> {
  return chatApp.handleEndpoint(chatApp.endpoints.readChat, { request, conversationId });
}

export const Route = createFileRoute("/api/chat/$conversationId/")({
  server: {
    handlers: {
      POST: ({ request, params }) => reconnectNativeChat(request, params.conversationId),
    },
  },
});
