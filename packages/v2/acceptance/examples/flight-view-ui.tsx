import { useState, type ReactNode } from "react";
import { createChatContext } from "@sweatpan.tsx/chat";
import type {
  FlightClient,
  FlightPart,
  FlightView,
  FlightCommand,
  FlightReceipt,
} from "./flight-view-contract.ts";

import { firstFlightAnswer, flightPartLabel } from "./flight-view-presentation.ts";

export const { ChatProvider, useChat } = createChatContext<
  FlightView,
  FlightCommand,
  FlightReceipt
>();

/** One session boundary, multiple independently subscribed components. */
export function FlightPanel({ client }: { readonly client: FlightClient }) {
  return (
    <ChatProvider client={client}>
      <FlightMessages />
      <FlightQuestions />
    </ChatProvider>
  );
}

export function FlightMessages() {
  const { view } = useChat();
  function render(parts: readonly FlightPart[]): ReactNode {
    return parts.map((part) => (
      <section key={part.id} data-node={part.id}>
        <p>{flightPartLabel(part)}</p>
        {"parts" in part && render(part.parts)}
      </section>
    ));
  }
  return <div>{view && render(view.messages)}</div>;
}

export function FlightQuestions() {
  const { view, answer, refresh } = useChat();
  const [error, setError] = useState(false);
  return (
    <div>
      {view?.questions.map((target) => (
        <button
          key={target.id}
          onClick={() => {
            setError(false);
            void answer(firstFlightAnswer(target))
              .then(() => refresh())
              .catch(() => setError(true));
          }}
        >
          Answer {target.question.kind}
        </button>
      ))}
      {error && <p role="alert">Answer not confirmed. Reconnect before choosing again.</p>}
    </div>
  );
}
