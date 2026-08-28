import { createFileRoute } from "@tanstack/react-router";
import { chatApp, withDefaultSystemPrompt } from "../server/chat-application";

export async function postNativeChat(request: Request): Promise<Response> {
  return chatApp.handleEndpoint(chatApp.endpoints.postChat, await withDefaultSystemPrompt(request));
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: ({ request }) => postNativeChat(request),
    },
  },
});
