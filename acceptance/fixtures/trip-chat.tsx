import {
  makePlugin,
  useChat,
  type ReactChatClient,
  type ReactChatUIPart,
  type ReactRenderableProps,
} from "@sweatpants/react-chat";
import { bookTrip } from "./book-trip.ts";
import { confirmedTrip } from "./confirmed-trip.ts";

type Choice =
  | { action: "accept"; content: { value: string } }
  | { action: "decline" }
  | { action: "cancel" };

export function ChoiceCard({
  choices,
  message,
  onRespond,
  disabled,
  response,
}: ReactRenderableProps<Choice> & { choices: string[]; message: string }) {
  return (
    <section aria-label={message}>
      <p>{message}</p>
      {choices.map((value) => (
        <button
          key={value}
          disabled={disabled || !!response}
          onClick={() => onRespond({ action: "accept", content: { value } })}
        >
          {value}
        </button>
      ))}
      <button disabled={disabled || !!response} onClick={() => onRespond({ action: "decline" })}>
        Decline
      </button>
      <button disabled={disabled || !!response} onClick={() => onRespond({ action: "cancel" })}>
        Cancel choice
      </button>
    </section>
  );
}

// Real UI authoring, inspired by yo-chat's flight/seat plugins and yo-workflow's
// explicit accept/decline/cancel controls. No plugin execution is simulated.
export const tripPlugin = makePlugin(bookTrip)
  .onElicit({
    flight: function* (input, ctx) {
      const result = yield* ctx.render(ChoiceCard, {
        choices: input.context.flights,
        message: input.message,
      });
      return result.action === "accept"
        ? { action: "accept", content: { flight: result.content.value } }
        : result;
    },
    seat: function* (input, ctx) {
      const result = yield* ctx.render(ChoiceCard, {
        choices: input.context.seats,
        message: input.message,
      });
      return result.action === "accept"
        ? { action: "accept", content: { seat: result.content.value } }
        : result;
    },
  })
  .build();

// One server elicitation can contain several local UI steps. Only the final
// plugin result crosses back to the tool and its response schema.
export const confirmedTripPlugin = makePlugin(confirmedTrip)
  .onElicit({
    chooseFlight: function* (input, ctx) {
      const flight = yield* ctx.render(ChoiceCard, {
        choices: input.context.flights,
        message: input.message,
      });
      if (flight.action !== "accept") {
        return flight;
      }
      const confirmation = yield* ctx.render(ChoiceCard, {
        choices: ["Confirm"],
        message: `Confirm ${flight.content.value}`,
      });
      return confirmation.action === "accept"
        ? { action: "accept", content: { flightId: flight.content.value, confirmed: true } }
        : confirmation;
    },
  })
  .build();

function Parts({ parts }: { parts: readonly ReactChatUIPart[] }) {
  return (
    <>
      {parts.map((part) => {
        if (part.type === "text") {
          return <span key={part.id} dangerouslySetInnerHTML={{ __html: part.rendered }} />;
        }
        if (part.type === "render") {
          return (
            <div
              key={part.id}
              data-render-id={part.id}
              data-render-state={part.state}
              data-elicit-id={part.parentElicitId}
            >
              {part.node}
            </div>
          );
        }
        if (part.type === "message") {
          return <Parts key={part.id} parts={part.message.parts} />;
        }
        if (part.type === "tool-call" || part.type === "activity" || part.type === "elicit") {
          return <Parts key={part.id} parts={part.parts} />;
        }
        return null;
      })}
    </>
  );
}

/** A consumer authors this component entirely through the public hook. */
export function TripChat({ client }: { client: ReactChatClient }) {
  const chat = useChat({ client });
  return (
    <div>
      <button disabled={!chat.canSendMessage} onClick={() => void chat.sendMessage("Book Oslo")}>
        Book trip
      </button>
      <button onClick={() => void chat.stop()}>Stop</button>
      <button onClick={() => void chat.sendMessage("Replace booking")}>Replace booking</button>
      <output aria-label="Chat status">{chat.status}</output>
      {chat.error && <p role="alert">{chat.error.message}</p>}
      {chat.messages.map((message) => (
        <article key={message.id} aria-label={message.role}>
          <Parts parts={message.parts} />
        </article>
      ))}
    </div>
  );
}
