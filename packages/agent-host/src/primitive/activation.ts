import type { Runtime, RuntimeExecution } from "@sweatpants/foundation/computation";
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

/** Runs the same chat and journal computation under the caller's native runtime.
 * The caller owns the journal; cancellation waits for activation cleanup before closing it.
 */
export function startChatActivation<Y>(
  runtime: Runtime<Y>,
  options: ChatCapabilities<Y>,
  input: TurnInput,
  journal: PendingJournal,
  events: {
    publish?(event: ModelStreamEvent, request: ChatRequest): void;
    accepted?(): void;
  } = {},
): RuntimeExecution<Activation<Json>> {
  return runtime.start(function* () {
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
  });
}
