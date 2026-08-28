import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export function pageNativeHistory(request: Request, conversationId: string): Promise<Response> {
  return chatApp.handleEndpoint(chatApp.endpoints.pageHistory, {
    request,
    conversationId,
  });
}

export const Route = createFileRoute("/api/chat/$conversationId/history:page")({
  server: {
    handlers: {
      POST: ({ request, params }) => pageNativeHistory(request, params.conversationId),
    },
  },
});
