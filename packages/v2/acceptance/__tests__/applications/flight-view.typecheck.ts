import { useChat as useFlightChat } from "../../examples/flight-view-ui.tsx";
import type { FlightClient, FlightTarget } from "../../examples/flight-view-contract.ts";

export function typedAnswers(client: FlightClient, target: FlightTarget) {
  void client.answer({ kind: "flight", target, value: { flight: "flight-1" } });
  void client.answer({ kind: "seat", target, value: { seat: "2A" } });
  // @ts-expect-error Seat answers cannot be sent under the flight discriminator.
  void client.answer({ kind: "flight", target, value: { seat: "2A" } });
  // @ts-expect-error UI answers are structured commands, not arbitrary text.
  void client.answer({ kind: "seat", target, value: "2A" });
  // @ts-expect-error Confirmation requires the explicitly supported value.
  void client.answer({ kind: "save", target, value: { confirm: false } });
}

import type {
  FlightPart,
  FlightQuestionContract,
  FlightOutput,
} from "../../examples/flight-view-contract.ts";
import type { ConversationNode } from "@sweatpan.ts/chat-client";
import { materializeConversation } from "@sweatpan.ts/chat-client";

export function renderTypedQuestion(part: FlightPart) {
  if (part.type === "question" && part.kind === "seat") {
    const seats: readonly string[] = part.question.seats;
    if (part.state === "answered") {
      const selected: "2A" | "2B" = part.response.seat;
      // @ts-expect-error A seat question cannot carry a flight answer.
      void part.response.flight;
      return [seats, selected];
    }
    const absent: undefined = part.response;
    return absent;
  }
  return undefined;
}

export const wrongHistory: FlightPart = {
  type: "question",
  id: "q",
  kind: "seat",
  question: { flight: "flight-1", seats: ["2A"] },
  state: "answered",
  // @ts-expect-error Context and response must belong to the same question kind.
  response: { flight: "flight-1" },
};
// @ts-expect-error Answered history requires its typed response.
export const missingAnswer: FlightPart = {
  type: "question",
  id: "q",
  kind: "seat",
  question: { flight: "flight-1", seats: ["2A"] },
  state: "answered",
};
export const prematureAnswer: FlightPart = {
  type: "question",
  id: "q",
  kind: "seat",
  question: { flight: "flight-1", seats: ["2A"] },
  state: "pending",
  // @ts-expect-error Pending history cannot claim a completed answer.
  response: { seat: "2A" },
};
export const wrongNode: ConversationNode<FlightQuestionContract, FlightOutput> = {
  type: "question",
  id: "q",
  parentId: null,
  order: 0,
  kind: "seat",
  // @ts-expect-error Normalized records retain the same correlation before materialization.
  question: { choices: [] },
  state: "pending",
};

export function materializedQuestions(
  nodes: readonly ConversationNode<FlightQuestionContract, FlightOutput>[],
) {
  for (const part of materializeConversation<FlightQuestionContract, FlightOutput>(nodes)) {
    renderTypedQuestion(part);
  }
}

// The application binding carries command types through context without casts.
export function useTypedFlightActions() {
  const { answer } = useFlightChat();
  return (target: FlightTarget) => {
    void answer({ kind: "seat", target, value: { seat: "2A" } });
    // @ts-expect-error Context binding preserves kind/value correlation.
    void answer({ kind: "seat", target, value: { flight: "flight-1" } });
  };
}
