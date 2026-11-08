import { createFileRoute } from "@tanstack/react-router";
import { cardHandlers } from "../server/cards.ts";

export const Route = createFileRoute("/api/cards/$execution")({
  server: { handlers: cardHandlers },
});
