import { ChatDemoPage } from "../chat/ChatDemoPage.tsx";
import { createDemoClient } from "../chat/client.ts";
import { decodeFlightInput } from "../tools/book-flight.ts";
import { flightUI } from "./flight-ui.tsx";
const plugins = [flightUI];
const createClient = (send?: typeof fetch) =>
  createDemoClient(
    {
      endpoint: "/api/flight-chat",
      storageKey: "yo-chat:flight-conversations:1",
      viewEvent: "flight-chat-view",
      decodeInput: decodeFlightInput,
    },
    send,
  );
export function FlightChat({ fetch }: { fetch?: typeof globalThis.fetch }) {
  return (
    <ChatDemoPage
      fetch={fetch}
      createClient={createClient}
      plugins={plugins}
      showToolLabel={false}
      title="Flight Booking"
      subtitle="Choose your flight. Find your seat. We’ll take care of the details."
      emptyTitle="Where are you headed?"
      emptyDescription="Choose a flight and seat, get a travel tip, and keep your itinerary in the conversation."
      placeholder="Where would you like to fly?"
      waitingLabel="Your choices are saved as you go. Complete the step above to continue."
      toolLabel="Book flight"
      workingLabel="Searching flights…"
      completedLabel="Demo booking recorded"
      suggestions={[
        { label: "NYC to LA", prompt: "Book a flight from NYC to Los Angeles" },
        { label: "SFO to Seattle", prompt: "I need to fly from San Francisco to Seattle" },
      ]}
    />
  );
}
