import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export function forwardNativeChatRead(request: Request, threadId: string): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const chatUrl = new URL("/api/chat", sourceUrl);
  const body = JSON.stringify({
    clientId: request.headers.get("x-client-id") ?? "yo-chat-stream-route",
    conversationId: threadId,
    ...(request.headers.get("x-known-window-token")
      ? { knownWindowToken: request.headers.get("x-known-window-token")! }
      : {}),
  });
  return chatApp.handle(
    new Request(chatUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body,
    }),
  );
}

export const Route = createFileRoute("/api/streams/chat/$threadId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => forwardNativeChatRead(request, params.threadId),
    },
  },
});
