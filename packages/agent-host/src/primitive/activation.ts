import { createChatGuest, type Invocation } from "./guest.ts";
import { createToolGuest } from "@sweatpants/tool-session/execution/tool-guest";
import type { PreparedToolExecution } from "@sweatpants/tool-session/placement";
import { createToolEffects, type ToolDefinition } from "@sweatpants/agent-sdk";
import type { Composition } from "@sweatpants/standard-durability";
import type {
  Runtime,
  RuntimeExecution,
  IterableOperation,
} from "@sweatpants/foundation/computation";
import type { Activation, PendingJournal } from "@sweatpants/foundation/journal";
import type { Json } from "@sweatpants/foundation";
import { activateJournal } from "@sweatpants/primitive-journal";
import type { ModelStreamEvent } from "@sweatpants/model-provider";
import {
  chatWork,
  handleChatRequest,
  type ChatRequest,
  type ChatCapabilities,
  type TurnInput,
} from "./chat.ts";

export type { ChatModelStream, ChatCapabilities, ChatRequest, TurnInput } from "./chat.ts";

export interface ChatActivationEvents {
  publish?(event: ModelStreamEvent, request: ChatRequest): void;
  accepted?(): void;
}

/** Compose one activation inside the caller's scope. The caller owns the journal. */
export function* activateChat<Y>(
  composition: Composition<Y>,
  options: ChatCapabilities<Y>,
  input: TurnInput,
  journal: PendingJournal,
  events: ChatActivationEvents = {},
): IterableOperation<Activation<Json>, Y> {
  const execution = prepareChatExecution(
    options.tools,
    options.execution?.prepare(options.tools, "tools"),
  );
  const Effects = createToolEffects(composition);
  return yield* Effects.withEffects(
    options.tools,
    {
      *effect(request) {
        return yield* options.effects[`${request.tool}.${request.key}`]!(request.input);
      },
    },
    function* () {
      if (execution.setup) {
        yield* execution.setup();
      }
      return yield* activateJournal(
        function* () {
          return createChatGuest(() =>
            chatWork(structuredClone(input), options.tools, execution.invoke),
          );
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
            handleChatRequest(options, request, Effects.operations, (event) =>
              events.publish?.(event, request),
            ),
        },
      );
    },
    options.effectMiddleware,
  );
}

/** Root convenience boundary. Cancellation waits for activation cleanup. */
export function startChatActivation<Y>(
  runtime: Runtime<Y>,
  composition: Composition<Y>,
  options: ChatCapabilities<Y>,
  input: TurnInput,
  journal: PendingJournal,
  events: ChatActivationEvents = {},
): RuntimeExecution<Activation<Json>> {
  return runtime.start(() => activateChat(composition, options, input, journal, events));
}

/** Admission binds registered tools and routes before cursor composition. No live acquisition. */
export function prepareChatExecution<Y>(
  tools: readonly ToolDefinition[],
  execution?: PreparedToolExecution<Y>,
) {
  const registered = new Set(tools.map((tool) => tool.name));
  if (registered.size !== tools.length) {
    throw new Error("Duplicate tools");
  }
  if (execution) {
    for (const tool of tools) {
      if (!execution.guests?.has(tool.name)) {
        throw new Error(`No portable execution route for tool: ${tool.name}`);
      }
    }
  }
  if (execution?.guests) {
    for (const name of execution.guests.keys()) {
      if (!registered.has(name)) {
        throw new Error(`Execution route references unregistered tool: ${name}`);
      }
    }
  }
  // Resolve defaults at admission, never inside the cursor's advancement loop.
  const guests = new Map(
    tools.map((tool) => [
      tool.name,
      execution?.guests?.get(tool.name) ??
        ((input: Json, callId: string) =>
          function* () {
            return createToolGuest(tool, input, callId);
          }),
    ]),
  );
  return {
    setup: execution?.setup,
    *invoke(
      this: void,
      { name, input, callId }: { name: string; input: Json; callId: string },
    ): IterableOperation<Json, Invocation<Y>> {
      const acquire = guests.get(name);
      if (!acquire) {
        throw new Error(`Unsupported tool: ${name}`);
      }
      return (yield { kind: "invoke-tool", work: acquire(input, callId) }) as Json;
    },
  };
}
