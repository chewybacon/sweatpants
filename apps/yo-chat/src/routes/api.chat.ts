import { createFileRoute } from "@tanstack/react-router";
import { chatApp, withDefaultSystemPrompt } from "../server/chat-application";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => chatApp.handle(await withDefaultSystemPrompt(request)),
    },
  },
});
