import type { Runtime, RuntimeExecution } from "@sweatpan.ts/runtime";
import type { Outcome } from "@standard-durability/core";
import type { z } from "zod";
import { chooseFlight, flightId, seatId, type flightOption } from "./flight.ts";
import { createReactElicitHost, SeatPicker } from "./react-elicit.tsx";
import type { BrowserChat } from "./transport.ts";
import { supportSchema } from "./elicit-support.ts";
import type { Answer, Question, Submission } from "./contracts.ts";

function FlightPicker({
  destination,
  flights,
  onRespond,
}: {
  readonly destination: string;
  readonly flights: z.infer<typeof flightOption>[];
  readonly onRespond: (id: z.infer<typeof flightId>) => void;
}) {
  return (
    <fieldset>
      <legend>Pick a demo flight to {destination}</legend>
      <p>Sample flights only. No real booking or payment.</p>
      <div className="flight-options">
        {flights.map((flight) => (
          <button key={flight.id} onClick={() => onRespond(flight.id)}>
            <strong>{flight.airline}</strong>
            <span>
              {flight.departure} → {flight.arrival}
            </span>
            <span>Choose {flight.airline}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
export const questionKey = (question: Pick<Question, "execution" | "grant">) =>
  JSON.stringify([question.execution, question.grant.requestId, question.grant.resolutionId]);
type Entry = {
  question: Question;
  task: RuntimeExecution<Outcome<unknown, unknown>>;
  command?: Answer;
  phase: "choosing" | "sending" | "answered" | "error";
};
type Issue = { readonly id: string; readonly message: string; readonly retryable: boolean };

/** One application-owned frontend session; React consumers are passive subscribers. */
export function createFlightFrontend<Y>(runtime: Runtime<Y>, client: BrowserChat) {
  const host = createReactElicitHost(runtime);
  const plugin = host.definePlugin(chooseFlight).onElicit({
    *pickFlight(args, ctx) {
      const value = yield* ctx.render(FlightPicker, args.context);
      return { ok: true, value };
    },
    *pickSeat(args, ctx) {
      const value = yield* ctx.render(SeatPicker, args.context);
      return { ok: true, value };
    },
  });
  const responder = host.bindPlugin(plugin);
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let issues: readonly Issue[] = [];
  let unsubscribe: (() => void) | undefined;
  function publish() {
    issues = [...entries]
      .filter(([, entry]) => entry.phase === "error")
      .map(([id, entry]) => ({
        id,
        retryable: Boolean(entry.command),
        message: entry.command
          ? "Answer not confirmed. Retry sends the same choice."
          : "Could not open this choice. Reconnect to try again.",
      }));
    for (const notify of [...listeners]) {
      notify();
    }
  }
  async function send(entry: Entry) {
    if (!entry.command || entry.phase === "sending") {
      return;
    }
    entry.phase = "sending";
    publish();
    try {
      await client.answer(entry.command);
      entry.phase = "answered";
    } catch {
      entry.phase = "error";
    } finally {
      publish();
      await client.refresh().catch(() => undefined);
    }
  }
  function reconcile() {
    const view = client.getSnapshot().view;
    if (!view) {
      return;
    }
    const pending = new Map(view.questions.map((question) => [questionKey(question), question]));
    for (const [id, entry] of entries) {
      if (!pending.has(id)) {
        entries.delete(id);
        void entry.task.cancel();
      }
    }
    publish();
    if (view.active) {
      return;
    }
    for (const [id, question] of pending) {
      if (entries.has(id)) {
        continue;
      }
      const task = runtime.start(() =>
        responder.operations.respond(question.selection, {
          execution: question.execution,
          grant: question.grant,
          program: chooseFlight.id,
          declaration: chooseFlight.elicits[question.kind],
          input: question.input,
        }),
      );
      const entry: Entry = { question, task, phase: "choosing" };
      entries.set(id, entry);
      void task.result
        .then(async (outcome) => {
          if (entries.get(id) !== entry || !outcome.ok) {
            return;
          }
          entry.command =
            question.kind === "pickFlight"
              ? { ...question, kind: "pickFlight", value: flightId.parse(outcome.value) }
              : { ...question, kind: "pickSeat", value: seatId.parse(outcome.value) };
          await send(entry);
        })
        .catch(() => {
          if (entries.get(id) === entry) {
            entry.phase = "error";
            publish();
          }
        });
    }
  }
  return {
    host,
    getSnapshot: () => issues,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    submit(command: Submission) {
      return client.submit({ ...command, support: [supportSchema.parse(plugin.support)] });
    },
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.phase === "error" && entry.command) {
        void send(entry);
      }
    },
    connect() {
      if (!unsubscribe) {
        unsubscribe = client.subscribe(reconcile);
        reconcile();
      }
    },
    async disconnect() {
      unsubscribe?.();
      unsubscribe = undefined;
      const running = [...entries.values()];
      entries.clear();
      publish();
      await Promise.all(running.map((entry) => entry.task.cancel()));
    },
  };
}
export type FlightFrontend = Omit<ReturnType<typeof createFlightFrontend>, "host"> & {
  readonly host: Pick<ReturnType<typeof createReactElicitHost>, "getSnapshot" | "subscribe">;
};
