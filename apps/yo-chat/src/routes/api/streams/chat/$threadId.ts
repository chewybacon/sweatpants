import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export function readNativeChat(request: Request, conversationId: string): Promise<Response> {
  const knownWindowToken = request.headers.get("x-known-window-token")?.trim();
  return chatApp.handleEndpoint(chatApp.endpoints.readChat, {
    request,
    conversationId,
    ...(knownWindowToken ? { knownWindowToken } : {}),
  });
}

export const Route = createFileRoute("/api/streams/chat/$threadId")({
  server: {
    handlers: {
      GET: ({ request, params }) => readNativeChat(request, params.threadId),
    },
  },
});
