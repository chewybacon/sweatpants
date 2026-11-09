import { createFileRoute } from "@tanstack/react-router";
import { cardChatHandlers } from "../server/card-chat.ts";
export const Route = createFileRoute("/api/card-chat/$thread")({
  server: { handlers: cardChatHandlers },
});
