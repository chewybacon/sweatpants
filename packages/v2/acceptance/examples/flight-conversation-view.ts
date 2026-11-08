import type { QuestionHistory } from "@sweatpan.ts/chat-client";
import { z } from "zod";
import type { Operation, Outcome } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { JournalReader, OwnedJournal } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatExecution } from "@sweatpan.ts/chat-host";
import type { ChatLoopResult } from "@sweatpan.ts/chat";
import { flightChat, flightResult, itineraryResult } from "./flight-chat.ts";
import { materializeConversation, type ConversationNode } from "@sweatpan.ts/chat-client";
import type {
  FlightQuestion,
  FlightQuestionContract,
  FlightOutput,
  FlightView,
  FlightCommand,
} from "./flight-view-contract.ts";

const flight = z.enum(["flight-1", "flight-2"]);
const seat = z.enum(["2A", "2B"]);
const command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flight"), value: z.object({ flight }) }),
  z.object({ kind: z.literal("seat"), value: z.object({ seat }) }),
  z.object({ kind: z.literal("save"), value: z.object({ confirm: z.literal(true) }) }),
]);
const effects = {
  flight: "flight.pick-v1",
  seat: "flight.seat-v1",
  save: "flight.confirm-save-v1",
};
function question(effect: string, input: unknown): FlightQuestion | undefined {
  if (effect === effects.flight) {
    return {
      kind: "flight",
      context: { choices: z.array(z.object({ id: z.string(), airline: z.string() })).parse(input) },
    };
  }
  if (effect === effects.seat) {
    return {
      kind: "seat",
      context: z.object({ flight: z.string(), seats: z.array(z.string()) }).parse(input),
    };
  }
  if (effect === effects.save) {
    return {
      kind: "save",
      context: z.object({ flight: z.string(), seat: z.string() }).parse(input),
    };
  }
  return undefined;
}
function historyState<A>(
  state: "pending" | "cancelled" | "answered",
  parse: () => A,
): { state: "pending" | "cancelled" } | { state: "answered"; response: A } {
  return state === "answered" ? { state, response: parse() } : { state };
}
function historyQuestion(
  id: string,
  context: FlightQuestion,
  state: "pending" | "cancelled" | "answered",
  value: unknown,
): QuestionHistory<FlightQuestionContract> {
  switch (context.kind) {
    case "flight":
      return {
        type: "question",
        id,
        kind: context.kind,
        question: context.context,
        ...historyState(state, () => ({ flight: flight.parse(value) })),
      };
    case "seat":
      return {
        type: "question",
        id,
        kind: context.kind,
        question: context.context,
        ...historyState(state, () => ({ seat: seat.parse(value) })),
      };
    case "save":
      return {
        type: "question",
        id,
        kind: context.kind,
        question: context.context,
        ...historyState(state, () => {
          z.literal("save").parse(value);
          return { confirm: true as const };
        }),
      };
  }
}
const sample = z.object({
  ok: z.literal(true),
  value: z.object({
    response: z.object({
      message: z.object({
        content: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            toolCall: z.object({ id: z.string(), name: z.string() }).optional(),
          }),
        ),
      }),
    }),
  }),
});

/** Pinned flight application decoder; no provider or evaluator execution on reads.
 * Structured UI commands adapt to the existing authored scalar answer contracts.
 * This does not change the pinned tool programs or their durable input schemas. */
export function createFlightConversationView<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
  chat: ChatExecution<ChatLoopResult, Y>,
) {
  return {
    observe() {
      return runtime.composition.scoped(function* () {
        const nodes: ConversationNode<FlightQuestionContract, FlightOutput>[] = [];
        const targets: FlightView["questions"][number][] = [];
        const root = yield* journal.read();
        const userId = JSON.stringify([journal.id, "user"]);
        nodes.push({ type: "message", id: userId, parentId: null, order: 0, role: "user" });
        nodes.push({
          type: "text",
          id: `${userId}:text`,
          parentId: userId,
          order: 0,
          text: z.object({ prompt: z.string() }).parse(root.admission?.input).prompt,
        });
        function* collect(
          reader: JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
          parentId: string | null,
        ): Operation<void, Y> {
          const state = yield* reader.read();
          const entries: {
            id: string;
            sequence: number;
            request: CapabilityRequest;
            outcome?: Outcome<unknown, unknown>;
            cancelled?: boolean;
          }[] = [];
          for (let offset = 0; offset < state.history.end.position; ) {
            const page = yield* state.history.read(offset, 128);
            if (!page.length) {
              throw new Error("Incomplete flight history");
            }
            entries.push(
              ...page.map((entry) => ({
                id: entry.receipt,
                sequence: entry.sequence,
                request: entry.request as CapabilityRequest,
                outcome: entry.outcome,
              })),
            );
            offset = page.at(-1)!.sequence + 1;
          }
          if (state.status === "running" && state.pending) {
            entries.push({
              id: state.pending.id,
              sequence: state.pending.sequence,
              request: state.pending.request as CapabilityRequest,
              cancelled: state.interaction?.state === "invalidated",
            });
          }
          // Cancellation is retained control evidence, not an invented failed answer.
          if (
            state.cancellation &&
            !entries.some((entry) => entry.id === state.cancellation!.requestId)
          ) {
            entries.push({
              id: state.cancellation.requestId,
              sequence: state.cancellation.position,
              request: state.cancellation.request as CapabilityRequest,
              cancelled: true,
            });
          }
          const calls = new Map<
            string,
            Extract<ConversationNode<FlightQuestionContract, FlightOutput>, { type: "tool-call" }>
          >();
          for (const entry of entries) {
            const id = JSON.stringify([reader.id, entry.id]);
            const order = entry.sequence + 1;
            const context = question(entry.request.effect, entry.request.input);
            if (context) {
              const answered = entry.outcome?.ok
                ? z.object({ ok: z.literal(true), value: z.unknown() }).parse(entry.outcome.value)
                : undefined;
              nodes.push({
                ...historyQuestion(
                  id,
                  context,
                  entry.cancelled ? "cancelled" : answered ? "answered" : "pending",
                  answered?.value,
                ),
                parentId,
                order,
              });
              if (!entry.outcome && !entry.cancelled && state.interaction?.state === "waiting") {
                targets.push({
                  id,
                  execution: reader.id,
                  grant: state.interaction.grant,
                  question: context,
                });
              }
            } else if (entry.request.effect === `${flightChat.id}/sample` && entry.outcome?.ok) {
              calls.clear();
              nodes.push({ type: "message", id, parentId, order, role: "assistant" });
              for (const [index, part] of sample
                .parse(entry.outcome.value)
                .value.response.message.content.entries()) {
                if (part.type === "text") {
                  nodes.push({
                    type: "text",
                    id: `${id}:${index}`,
                    parentId: id,
                    order: index,
                    text: part.text ?? "",
                  });
                }
                if (part.type === "tool-call" && part.toolCall) {
                  const node = {
                    type: "tool-call" as const,
                    id: `${id}:${index}`,
                    parentId: id,
                    order: index,
                    callId: part.toolCall.id,
                    name: part.toolCall.name,
                    state: "pending" as const,
                  };
                  nodes.push(node);
                  calls.set(part.toolCall.id, node);
                }
              }
            } else if (entry.request.effect === `${flightChat.id}/tools`) {
              const batch = z
                .array(z.object({ id: z.string(), name: z.string() }))
                .parse(entry.request.input);
              const links = yield* reader.readChildren(entry.id);
              if (links.length && links.length !== batch.length) {
                throw new Error("Incomplete flight child placement");
              }
              for (const [index, link] of links.entries()) {
                const call = batch[index]!;
                const node = calls.get(call.id);
                if (!node || node.name !== call.name) {
                  throw new Error("Missing flight tool parent");
                }
                const child = yield* reader.openChild(link.childId);
                const snapshot = yield* child.read();
                nodes[nodes.indexOf(node)] = {
                  ...node,
                  state: snapshot.status,
                  output:
                    snapshot.status === "completed"
                      ? z.union([flightResult, itineraryResult]).parse(snapshot.value)
                      : undefined,
                };
                yield* collect(child, node.id);
              }
            } else if (entry.request.effect === "flight.travel-tip-v1" && entry.outcome?.ok) {
              const tip = z
                .object({ ok: z.literal(true), value: z.object({ text: z.string() }) })
                .parse(entry.outcome.value);
              nodes.push({ type: "message", id, parentId, order, role: "assistant" });
              nodes.push({
                type: "text",
                id: `${id}:text`,
                parentId: id,
                order: 0,
                text: tip.value.text,
              });
            }
          }
        }
        yield* collect(journal, null);
        return {
          status: root.status,
          messages: materializeConversation<FlightQuestionContract, FlightOutput>(nodes),
          questions: targets,
        } satisfies FlightView;
      });
    },
    *answer(input: FlightCommand) {
      const parsed = command.parse(input);
      const target = input.target;
      const child = yield* journal.openDescendantInteractions(target.execution);
      const stored = yield* child.journal.interactions.request(target.grant);
      if (
        !stored ||
        typeof stored !== "object" ||
        !("effect" in stored) ||
        stored.effect !== effects[parsed.kind]
      ) {
        throw new Error("Question kind does not match stored authority");
      }
      const value =
        parsed.kind === "flight"
          ? parsed.value.flight
          : parsed.kind === "seat"
            ? parsed.value.seat
            : "save";
      const receipt = yield* chat.answer(target, { ok: true, value });
      return { receipt: receipt.entry.receipt, duplicate: receipt.duplicate };
    },
  };
}
