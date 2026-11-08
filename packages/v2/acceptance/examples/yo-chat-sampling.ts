import type { Outcome } from "@standard-durability/core";
import type { ChatLoopSample, ChatSamplingError, ChatSampling } from "@sweatpan.ts/chat";
import { createPullStream, type Runtime } from "@sweatpan.ts/runtime";
import type { TextSampling } from "./chat-prototype/sampling.ts";

/** Completed-only protocol peer for journeys that do not produce progress. */
export function completedSampling<Y>(
  runtime: Runtime<Y>,
  sampling: ChatSampling<Y>,
): TextSampling<Y> {
  return {
    stream(request) {
      return createPullStream<string, Outcome<ChatLoopSample, ChatSamplingError>, Y, Y>(
        runtime.composition,
        () =>
          function* () {
            return { done: true as const, value: yield* sampling.sample(request) };
          },
      );
    },
  };
}
