import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { defineChatProgram } from "@sweatpan.ts/chat-host";
import type { ChatSampling, ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import { createRecovery, type OwnedJournal } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
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
export interface Dependencies<Y> {
  readonly sampling: ChatSampling<Y>;
}
export function bindTurn<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
  dependencies: Dependencies<Y>,
) {
  return program.bind(runtime, {
    journal,
    tools: [],
    sampling: dependencies.sampling,
    matches: isDeepStrictEqual,
    recovery: (options) => createRecovery(runtime.composition, options),
  });
}
