import type { Api, Composition } from "@standard-durability/core";
import type {
  ChatContext,
  ChatModel,
  ChatSampling,
  ChatSamplingDriver,
  ChatLoopSample,
} from "./contracts.ts";
import { prepareChatInference } from "./inference.ts";
/** Create a scoped preparation API with the pure assembler as its default driver.
 * install replaces preparation; around composes strategies in the caller's scope.
 * Each call is ordinary runtime work, with no journal, cache or provider dispatch. */
export function createChatContext<Y>(
  composition: Composition<Y>,
  name: string,
): Api<ChatContext<Y>, Y> {
  return composition.createApi<ChatContext<Y>>(name, {
    operations: {
      *prepare(input) {
        return prepareChatInference(input);
      },
    },
  });
}
/** Scoped model selection; pass this facade's operations into createChatSampling. */
export function createChatModel<Y>(
  composition: Composition<Y>,
  name: string,
  driver: ChatModel<Y>,
): Api<ChatModel<Y>, Y> {
  return composition.createApi<ChatModel<Y>>(name, {
    operations: driver,
  });
}
/** Host sampling composes scoped model selection with an application inference driver.
 * No recording occurs here: invoke through a recorded domain exchange. Driver exceptions
 * propagate; expected middleware denials remain data. Returned provenance is checked. */
export function createChatSampling<Y, Sample extends ChatLoopSample>(
  composition: Composition<Y>,
  name: string,
  driver: ChatSamplingDriver<Y, Sample>,
): Api<ChatSampling<Y, Sample>, Y> {
  return composition.createApi<ChatSampling<Y, Sample>>(name, {
    operations: {
      *sample(request) {
        const selected = structuredClone(yield* driver.model.select(structuredClone(request)));
        const identity = { id: selected.id, api: selected.api, provider: selected.provider };
        const sample = yield* driver.sample(selected, structuredClone(request));
        if (
          sample.model.id !== identity.id ||
          sample.model.api !== identity.api ||
          sample.model.provider !== identity.provider
        ) {
          throw new Error("Sample differs from selected model");
        }
        return { ok: true, value: sample };
      },
    },
  });
}
