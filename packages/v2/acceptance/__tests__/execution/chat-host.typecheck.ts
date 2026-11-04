import { z } from "zod";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatToolDefinition } from "@sweatpan.ts/providers";
import { defineTool } from "@sweatpan.ts/tools";
import {
  createChatToolBinding,
  defineChatProgram,
  type ChatProgramBinding,
  type ChatExecution,
  type ChatRecoveryFactory,
  type ChatToolBinding,
} from "@sweatpan.ts/chat-host";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Operation } from "@standard-durability/core";
import type { HostedResult } from "@sweatpan.ts/hosting";

export function chatProgramInference<Y>(
  runtime: Runtime<Y>,
  binding: ChatProgramBinding<{ summary: string }, Y>,
) {
  const program = defineChatProgram({
    id: "summary-v1",
    history() {
      return [{ role: "user", content: "Summarize" }];
    },
    toolResult(value) {
      return { content: String(value), isError: false };
    },
    result(completed) {
      return { summary: JSON.stringify(completed.response.message) };
    },
  });
  const execution = program.bind(runtime, binding);
  const operation: Operation<
    HostedResult<{ summary: string }, CapabilityRequest>,
    Y
  > = execution.run();
  // @ts-expect-error Application result projection is retained, not erased to unknown/string.
  const wrong: ChatExecution<string, Y> = execution;
  // @ts-expect-error Recorded program identity is immutable.
  program.id = "changed";
  void operation;
  void wrong;
}

// Checked through both source and emitted public declarations; never executed.
export function chatHostInference<Y>(
  runtime: Runtime<Y>,
  recovery: ChatRecoveryFactory<Y>,
  definition: ChatToolDefinition,
) {
  const first = z.string().transform((value) => ({ length: value.length }));
  const second = z.number().transform(String);
  const count = defineTool("count-v1")
    .parameters(first)
    .execute(function* (input) {
      return input.length;
    });
  const text = defineTool("text-v1")
    .parameters(second)
    .execute(function* (input) {
      return input.toUpperCase();
    });
  const bindings: readonly ChatToolBinding<Y>[] = [
    createChatToolBinding(runtime, count, {
      definition,
      recovery,
      matches: () => true,
      *configure({ host }) {
        yield* host.around({
          *run(args, next) {
            const result = yield* next(...args);
            if (result.state === "completed") {
              const value: number = result.value;
              void value;
              // @ts-expect-error This tool completes with a number.
              const wrong: string = result.value;
              void wrong;
            }
            return result;
          },
        });
      },
    }),
    createChatToolBinding(runtime, text, { definition, recovery, matches: () => true }),
  ];
  return bindings;
}
