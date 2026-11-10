import { createFileRoute } from "@tanstack/react-router";
import { CardChat } from "../card-chat/CardChat.tsx";
export const Route = createFileRoute("/chat/cards")({ component: CardChat });
