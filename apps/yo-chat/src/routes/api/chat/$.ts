import { createFileRoute } from "@tanstack/react-router";
import { handleChatRequest } from "../../api.chat";

export const Route = createFileRoute("/api/chat/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleChatRequest(request),
      POST: ({ request }) => handleChatRequest(request),
    },
  },
});
