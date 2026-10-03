import { createFileRoute } from "@tanstack/react-router";
import { chatApp, withDefaultSystemPrompt } from "../server/chat-application";

export async function handleChatRequest(request: Request): Promise<Response> {
  return chatApp.handler(await withDefaultSystemPrompt(request));
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      GET: ({ request }) => handleChatRequest(request),
      POST: ({ request }) => handleChatRequest(request),
    },
  },
});
