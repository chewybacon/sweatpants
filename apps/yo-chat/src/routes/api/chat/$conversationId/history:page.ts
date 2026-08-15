import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export const Route = createFileRoute("/api/chat/$conversationId/history:page")({
  server: {
    handlers: {
      POST: ({ request }) => chatApp.handle(request),
    },
  },
});
