import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { bookFlightPlugin } from "@/tools/book-flight/plugin";

export const Route = createFileRoute("/chat/flight/")({
  component: FlightChatDemo,
});

function FlightChatDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "flight",
        label: "Flight Booking",
        pipeline: "markdown",
        plugins: [bookFlightPlugin],
        suggestions: [
          { label: "NYC to LA", message: "Book a flight from NYC to Los Angeles" },
          { label: "SFO to Seattle", message: "I need to fly from San Francisco to Seattle" },
        ],
      }}
    />
  );
}
