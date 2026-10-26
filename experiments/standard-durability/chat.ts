import {
  activateChat,
  type ChatActivationEvents,
  type ChatCapabilities,
  type TurnInput,
} from "../../packages/agent-host/src/primitive/activation.ts";
import type { PendingJournal } from "@sweatpants/foundation/journal";
import type {
  ModelProviderStreamRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../packages/model-provider/src/index.ts";
import type { Composition } from "./contracts.ts";

/** The signature describes a complete sample, including provisional output. */
export interface ModelApi {
  sample(
    request: ModelProviderStreamRequest,
    publish: (event: ModelStreamEvent) => void,
  ): ModelResponse;
}
export type ScopedChatCapabilities<Y> = Omit<ChatCapabilities<Y>, "model"> & {
  model: Omit<ChatCapabilities<Y>["model"], "driver">;
};

/** The same production chat activation, with model dispatch through a scoped API. */
export function createScopedChat<Y>(composition: Composition<Y>) {
  const Model = composition.createApi<ModelApi>("standard-durability:chat-model", {
    *sample() {
      throw new Error("Chat model not installed");
    },
  });
  return {
    Model,
    activate(
      capabilities: ScopedChatCapabilities<Y>,
      input: TurnInput,
      journal: PendingJournal,
      events: ChatActivationEvents = {},
    ) {
      return activateChat(
        {
          ...capabilities,
          model: {
            ...capabilities.model,
            driver: {
              // Each sample owns its subscription/native resources. Cleanup completes
              // before the final transformed response reaches journal acceptance.
              stream: (request, publish) =>
                composition.scoped(() => Model.operations.sample(request, publish)),
            },
          },
        },
        input,
        journal,
        events,
      );
    },
  };
}
