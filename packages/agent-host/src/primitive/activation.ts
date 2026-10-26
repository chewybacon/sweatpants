import type {
  Runtime,
  RuntimeExecution,
  IterableOperation,
} from "@sweatpants/foundation/computation";
import type { Activation, PendingJournal } from "@sweatpants/foundation/journal";
import type { Json } from "@sweatpants/foundation";
import { activateJournal, createIteratorGuest } from "@sweatpants/primitive-journal";
import type { ModelStreamEvent } from "@sweatpants/model-provider";
import {
  chatWork,
  handleChatRequest,
  type ChatRequest,
  type ChatCapabilities,
  type TurnInput,
} from "./chat.ts";

export type { ChatModelStream, ChatCapabilities, TurnInput } from "./chat.ts";

export interface ChatActivationEvents {
  publish?(event: ModelStreamEvent, request: ChatRequest): void;
  accepted?(): void;
}

/** Compose one activation inside the caller's scope. The caller owns the journal. */
export function* activateChat<Y>(
  options: ChatCapabilities<Y>,
  input: TurnInput,
  journal: PendingJournal,
  events: ChatActivationEvents = {},
): IterableOperation<Activation<Json>, Y> {
  return yield* activateJournal(
    function* () {
      return createIteratorGuest(() => chatWork(structuredClone(input), options.tools));
    },
    journal,
    {
      classify: (request) =>
        request.kind === "elicit"
          ? "park"
          : request.kind === "effect"
            ? request.retrySafety.mode
            : "repeatable",
      accepted: () => events.accepted?.(),
      handler: (request) =>
        handleChatRequest(options, request, (event) => events.publish?.(event, request)),
    },
  );
}

/** Root convenience boundary. Cancellation waits for activation cleanup. */
export function startChatActivation<Y>(
  runtime: Runtime<Y>,
  options: ChatCapabilities<Y>,
  input: TurnInput,
  journal: PendingJournal,
  events: ChatActivationEvents = {},
): RuntimeExecution<Activation<Json>> {
  return runtime.start(() => activateChat(options, input, journal, events));
}
