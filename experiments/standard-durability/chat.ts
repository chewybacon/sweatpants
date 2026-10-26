import type {
  ChatActivationEvents,
  ChatCapabilities,
  TurnInput,
} from "../../packages/agent-host/src/primitive/activation.ts";
import {
  chatWork,
  handleChatRequest,
  type ChatRequest,
} from "../../packages/agent-host/src/primitive/chat.ts";
import {
  activateJournal,
  createIteratorGuest,
} from "../../packages/primitive-journal/src/index.ts";
import { assertJson } from "@sweatpants/foundation";
import type { PendingJournal } from "@sweatpants/foundation/journal";
import {
  decodeModelContext,
  decodeModelResponse,
  type ModelStreamEvent,
} from "../../packages/model-provider/src/index.ts";
import { bindApi, createHost, type ApiRequest } from "./api-bindings.ts";
import { ModelDefinition } from "./model-api.ts";
import type { Composition, Work } from "./contracts.ts";

export type ScopedChatCapabilities<Y> = Omit<ChatCapabilities<Y>, "model"> & {
  model: Omit<ChatCapabilities<Y>["model"], "driver">;
};
export type ModelConfiguration = ScopedChatCapabilities<never>["model"];
export interface ModelOutput {
  publish(event: ModelStreamEvent): void;
}
export type TypedChatEvents = Omit<ChatActivationEvents, "publish"> & {
  publish?(event: ModelStreamEvent, request: ChatRequest | ApiRequest): void;
};

/** Same production chat computation and journal, with a declared model boundary. */
export function createScopedChat<Y>(composition: Composition<Y>) {
  const Model = bindApi(ModelDefinition, createHost(composition));
  const ModelConfig = composition.createContext<ModelConfiguration>("chat-model-config");
  const Output = composition.createApi<ModelOutput>("chat-model-output", {
    *publish() {
      throw new Error("Model output not installed");
    },
  });
  return {
    Model,
    ModelConfig,
    Output,
    activate(
      capabilities: ScopedChatCapabilities<Y>,
      input: TurnInput,
      journal: PendingJournal,
      events: TypedChatEvents = {},
    ) {
      const withSampling = <T>(
        model: ModelConfiguration,
        source: ChatRequest | ApiRequest,
        work: Work<T, Y>,
      ) =>
        composition.scoped(function* () {
          yield* ModelConfig.set(model);
          yield* Output.install({
            *publish(event) {
              events.publish?.(event, source);
            },
          });
          return yield* work();
        });
      return activateJournal(
        function* () {
          return createIteratorGuest(() =>
            chatWork(structuredClone(input), capabilities.tools, function* (request) {
              const outcome = yield* Model.operations.sample(decodeModelContext(request.context));
              if (!outcome.ok) {
                throw new Error(outcome.error.message);
              }
              return outcome.value;
            }),
          );
        },
        journal,
        {
          classify: (request) =>
            request.kind === "elicit"
              ? "park"
              : request.kind === "effect" || request.kind === "api"
                ? request.retrySafety.mode
                : "repeatable",
          accepted: () => events.accepted?.(),
          handler: (request) => {
            if (request.kind === "api") {
              return withSampling(capabilities.model, request, () => Model.host.handle(request));
            }
            return handleChatRequest(
              {
                ...capabilities,
                model: {
                  ...capabilities.model,
                  driver: {
                    // Nested tool sampling retains its existing durable request in this slice.
                    stream: (nativeRequest) =>
                      withSampling(
                        { model: nativeRequest.model, streamOptions: nativeRequest.options },
                        request,
                        function* () {
                          const outcome = yield* Model.host.dispatch({
                            kind: "api",
                            api: ModelDefinition.id,
                            method: "sample",
                            version: ModelDefinition.operations.sample.version,
                            input: assertJson(nativeRequest.context),
                            retrySafety: { mode: "repeatable" },
                          });
                          if (!outcome.ok) {
                            throw new Error("Model sampling failed");
                          }
                          return decodeModelResponse(outcome.value);
                        },
                      ),
                  },
                },
              },
              request,
            );
          },
        },
      );
    },
  };
}
