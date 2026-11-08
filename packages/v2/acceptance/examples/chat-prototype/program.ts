import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createChatToolBinding, defineChatProgram } from "@sweatpan.ts/chat-host";
import type { ChatSampling, ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import { createRecovery, type OwnedJournal } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { chooseFlight, flightResult } from "./flight.ts";
import { installSelectedElicitHandlers } from "@sweatpan.ts/tools";
import { createCodeBinding } from "./code-mode.ts";
import { codeResult } from "./code-contracts.ts";
import { selectionSchema } from "./elicit-support.ts";
const input = z.object({
  prompt: z.string().min(1),
  history: z.custom<readonly ChatHistoryMessage[]>(Array.isArray),
});
export const program = defineChatProgram({
  id: "yo-chat-v2/text-turn-v1",
  history(admitted) {
    const value = input.parse(admitted);
    return [...value.history, { role: "user", content: value.prompt }];
  },
  toolResult() {
    throw new Error("Tools are not enabled");
  },
  result(completed) {
    return completed;
  },
});
export const flightProgram = defineChatProgram({
  id: "yo-chat-v2/flight-turn-v1",
  history(admitted) {
    const value = input.parse(admitted);
    return [...value.history, { role: "user", content: value.prompt }];
  },
  toolResult(value) {
    return { content: JSON.stringify(flightResult.parse(value)), isError: false };
  },
  result(completed) {
    return completed;
  },
});
function defineCodeProgram(id: string) {
  return defineChatProgram({
    id,
    history(admitted) {
      const value = input.parse(admitted);
      return [...value.history, { role: "user", content: value.prompt }];
    },
    toolResult(value, call) {
      if (call.name !== "run_lua") {
        return { content: JSON.stringify(flightResult.parse(value)), isError: false };
      }
      const result = codeResult.parse(value);
      return {
        content: JSON.stringify(result),
        isError: result.status === "invalid" || result.status === "failed",
      };
    },
    result(completed) {
      return completed;
    },
  });
}
export const legacyCodeProgram = defineCodeProgram("yo-chat-v2/code-turn-v1");
export const codeProgram = defineCodeProgram("yo-chat-v2/code-turn-v2");
export interface Dependencies<Y> {
  readonly sampling: ChatSampling<Y>;
  readonly loadLuaModule?: () => Promise<WebAssembly.Module>;
}
export function bindTurn<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
  dependencies: Dependencies<Y>,
  programId = program.id,
  admitted?: unknown,
) {
  const selected =
    programId === program.id
      ? program
      : programId === flightProgram.id
        ? flightProgram
        : programId === codeProgram.id
          ? codeProgram
          : programId === legacyCodeProgram.id
            ? legacyCodeProgram
            : undefined;
  if (!selected) {
    throw new Error("Unavailable conversation program");
  }
  const selections =
    programId === program.id
      ? []
      : z.object({ selections: z.array(selectionSchema) }).parse(admitted).selections;
  if (
    selections.some(
      (plan) =>
        plan.tool !== chooseFlight.id ||
        plan.routes.pickFlight !== "client" ||
        plan.routes.pickSeat !== "client",
    )
  ) {
    throw new Error("Unavailable retained flight handling policy");
  }
  const flightBindings = selections.map((selection) =>
    createChatToolBinding(runtime, chooseFlight, {
      definition: {
        name: "choose_flight",
        description:
          "Let the user pick a DEMO flight and seat using interactive cards. Use this when asked to pick or choose a flight. These are fictional sample flights; no real search, reservation, booking or payment occurs.",
        parameters: {
          type: "object",
          properties: {
            destination: { type: "string", description: "Destination city or airport" },
          },
          required: ["destination"],
          additionalProperties: false,
        },
      },
      matches: isDeepStrictEqual,
      recovery: (options) => createRecovery(runtime.composition, options),
      *configure({ host, effects }) {
        yield* installSelectedElicitHandlers(host, effects, chooseFlight, selection);
      },
    }),
  );
  const code =
    programId === codeProgram.id || programId === legacyCodeProgram.id
      ? createCodeBinding(
          runtime,
          flightBindings[0],
          dependencies.loadLuaModule,
          programId === legacyCodeProgram.id,
        )
      : undefined;
  return selected.bind(runtime, {
    journal,
    tools: code ? [code, ...flightBindings] : flightBindings,
    sampling: code
      ? {
          *sample(request) {
            const description = yield* code.describe();
            return yield* dependencies.sampling.sample({
              ...request,
              tools: [{ ...code.definition, description }],
            });
          },
        }
      : dependencies.sampling,
    matches: isDeepStrictEqual,
    recovery: (options) => createRecovery(runtime.composition, options),
  });
}
