import { createFileRoute } from "@tanstack/react-router";
import { flightChatHandlers } from "../server/chat.ts";
export const Route = createFileRoute("/api/flight-chat/$thread")({
  server: { handlers: flightChatHandlers },
});
