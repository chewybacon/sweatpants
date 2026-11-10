import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createChatContext, defineToolUI, ToolUIProvider, ToolOutlet } from "@sweatpan.tsx/chat";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolPresentationQuestion } from "@sweatpan.ts/chat-client";
import type {
  FlightClient,
  FlightPart,
  FlightView,
  FlightCommand,
  FlightReceipt,
} from "./flight-view-contract.ts";
import { chooseFlight, saveItinerary } from "./flight-chat.ts";
import { flightPartLabel } from "./flight-view-presentation.ts";

export const { ChatProvider, useChat } = createChatContext<
  FlightView,
  FlightCommand,
  FlightReceipt
>();

const plugins = [
  defineToolUI(chooseFlight, {
    pickFlight: ({ input, disabled, respond, outcome }) => (
      <button
        disabled={disabled}
        onClick={() => {
          const flight = input[0]?.id;
          if (flight === "flight-1" || flight === "flight-2") {
            void respond(flight);
          }
        }}
      >
        {outcome?.ok ? `Selected flight ${outcome.value}` : "Answer flight"}
      </button>
    ),
    pickSeat: ({ input, disabled, respond, outcome }) => (
      <button
        disabled={disabled}
        onClick={() => {
          const seat = input.seats[0];
          if (seat === "2A" || seat === "2B") {
            void respond(seat);
          }
        }}
      >
        {outcome?.ok ? `Selected seat ${outcome.value}` : "Answer seat"}
      </button>
    ),
  }),
  defineToolUI(saveItinerary, {
    confirmSave: ({ disabled, respond, outcome }) => (
      <button disabled={disabled} onClick={() => void respond("save")}>
        {outcome?.ok ? "Saved" : "Answer save"}
      </button>
    ),
  }),
];

/** The application still owns observation, commands and advancement. */
export function FlightPanel({ client }: { readonly client: FlightClient }) {
  return (
    <ChatProvider client={client}>
      <FlightPresentation client={client} />
    </ChatProvider>
  );
}

function FlightPresentation({ client }: { client: FlightClient }) {
  const { view, answer, refresh } = useChat();
  const [delivery, setDelivery] = useState<{ id: string; failed: boolean; value: unknown }>();
  const [error, setError] = useState<string>();
  const owner = useRef({ client, live: true, busy: false });
  useEffect(() => {
    const session = { client, live: true, busy: false };
    owner.current = session;
    return () => {
      session.live = false;
    };
  }, [client]);
  // This adapter translates this application's validated conversation vocabulary;
  // it is not a new generic conversation or delivery protocol.
  const source = useMemo(() => {
    const entries: ToolPresentationQuestion[] = [];
    function collect(parts: readonly FlightPart[], invocation: string) {
      for (const part of parts) {
        if ("parts" in part) {
          collect(part.parts, part.type === "tool-call" ? part.id : invocation);
        }
        if (part.type !== "question") {
          continue;
        }
        const target = view?.questions.find((target) => target.id === part.id);
        const effect =
          part.kind === "flight"
            ? chooseFlight.elicits.pickFlight
            : part.kind === "seat"
              ? chooseFlight.elicits.pickSeat
              : saveItinerary.elicits.confirmSave;
        const value =
          part.state !== "answered"
            ? undefined
            : part.kind === "flight"
              ? part.response.flight
              : part.kind === "seat"
                ? part.response.seat
                : "save";
        entries.push({
          id: part.id,
          execution: invocation,
          program: part.kind === "save" ? saveItinerary.id : chooseFlight.id,
          effect: effect.id,
          input: part.kind === "flight" ? part.question.choices : part.question,
          state: part.state === "answered" || part.state === "cancelled" ? part.state : "pending",
          delivery:
            delivery?.id === part.id ? (delivery.failed ? "unconfirmed" : "sending") : "idle",
          canRespond: !!target && !delivery,
          submitted: delivery?.id === part.id ? { ok: true, value: delivery.value } : undefined,
          outcome: part.state === "answered" ? { ok: true, value } : undefined,
          async respond(value) {
            const session = owner.current;
            const current = client
              .getSnapshot()
              .view?.questions.find((question) => question.id === part.id);
            if (
              !target ||
              !session.live ||
              session.client !== client ||
              session.busy ||
              delivery ||
              JSON.stringify(current) !== JSON.stringify(target)
            ) {
              return;
            }
            session.busy = true;
            let sent = false;
            setError(undefined);
            try {
              let command: FlightCommand;
              if (part.kind === "flight") {
                command = {
                  kind: "flight",
                  target,
                  value: { flight: await decode(chooseFlight.elicits.pickFlight.response!, value) },
                };
              } else if (part.kind === "seat") {
                command = {
                  kind: "seat",
                  target,
                  value: { seat: await decode(chooseFlight.elicits.pickSeat.response!, value) },
                };
              } else {
                await decode(saveItinerary.elicits.confirmSave.response!, value);
                command = { kind: "save", target, value: { confirm: true } };
              }
              if (
                !session.live ||
                owner.current !== session ||
                JSON.stringify(
                  client.getSnapshot().view?.questions.find((question) => question.id === part.id),
                ) !== JSON.stringify(target)
              ) {
                return;
              }
              sent = true;
              setDelivery({ id: part.id, failed: false, value });
              await answer(command);
              if (session.live && owner.current === session) {
                await refresh();
                session.busy = false;
                setDelivery(undefined);
              }
            } catch {
              if (session.live && owner.current === session) {
                if (sent) {
                  setDelivery({ id: part.id, failed: true, value });
                } else {
                  setError("Invalid flight response");
                }
              }
            } finally {
              if (!sent) {
                session.busy = false;
              }
            }
          },
        });
      }
    }
    collect(view?.messages ?? [], "conversation");
    const snapshot = Object.freeze(entries);
    // Immutable source: context replacement propagates each new snapshot to outlets.
    return { getSnapshot: () => snapshot, subscribe: () => () => {} };
  }, [view, answer, refresh, delivery, client]);
  return (
    <ToolUIProvider source={source} plugins={plugins}>
      <FlightMessages toolUI />
      {error && <p role="alert">{error}</p>}
      {delivery?.failed && (
        <p role="alert">Answer not confirmed. Reconnect before choosing again.</p>
      )}
    </ToolUIProvider>
  );
}

export function FlightMessages({ toolUI = false }: { readonly toolUI?: boolean }) {
  const { view } = useChat();
  function render(parts: readonly FlightPart[]): ReactNode {
    return parts.map((part) => (
      <section key={part.id} data-node={part.id}>
        <p>{flightPartLabel(part)}</p>
        {toolUI && part.type === "question" && <ToolOutlet question={part.id} />}
        {"parts" in part && render(part.parts)}
      </section>
    ));
  }
  return <div>{view && render(view.messages)}</div>;
}

async function decode<A, R>(schema: StandardSchemaV1<A, R>, input: unknown): Promise<R> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    throw new Error("Invalid flight response");
  }
  return result.value;
}
