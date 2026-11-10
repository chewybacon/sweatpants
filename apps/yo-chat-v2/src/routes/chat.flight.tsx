import { createFileRoute } from "@tanstack/react-router";
import { FlightChat } from "../flights/FlightChat.tsx";
export const Route = createFileRoute("/chat/flight")({ component: FlightChat });
