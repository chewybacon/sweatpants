import type { LogicalScope, ScopeInstruction } from "@sweatpan.ts/execution";
import { createPullStream, type Stream } from "@sweatpan.ts/runtime";
import type { Composition, Operation } from "@standard-durability/core";
import {
  runChat,
  streamChat,
  type ChatLoopEvent,
  type ChatStreamOptions,
  type ChatLoopOptions,
  type ChatLoopResult,
  prepareChatInference,
  createChatContext,
  createChatModel,
  createChatSampling,
  limitChatRounds,
  type ChatLoopSample,
  prepareChatCompaction,
  applyChatCompaction,
  type ChatCompactionRequest,
  type ChatHistoryMessage,
  type ChatInference,
} from "@sweatpan.ts/chat";
import type { ModelInfo } from "@sweatpan.ts/providers";

/** Public consumer against source and emitted declarations. */
export function chatConsumer(model: ModelInfo): ChatInference {
  const history: ChatHistoryMessage[] = [{ role: "user", content: "Hello" }];
  // @ts-expect-error Assistant history must identify its originating model.
  history.push({ role: "assistant", content: [] });
  return prepareChatInference({ model, history, tools: [], foreignReasoning: "omit" });
}

/** Compaction uses portable request data and an ordinary accepted string result. */
export function compactionConsumer(history: readonly ChatHistoryMessage[], summary: string) {
  const request: ChatCompactionRequest = prepareChatCompaction(history, history.length);
  return applyChatCompaction(history, request, summary);
}

/** Scoped preparation preserves native instructions and result types. */
export function contextApiConsumer<Y>(
  composition: Composition<Y>,
  model: ModelInfo,
): Operation<ChatInference, Y> {
  const context = createChatContext(composition, "chat-context");
  return context.operations.prepare({ model, history: [], tools: [] });
}

/** Guest orchestration retains domain instructions in source and built declarations. */
export function chatLoopConsumer(
  scope: LogicalScope,
  options: ChatLoopOptions,
): Operation<ChatLoopResult, import("@sweatpan.ts/core").CapabilityRequest | ScopeInstruction> {
  return runChat(scope, options);
}

/** Host-native work cannot be passed directly into the Guest sampling callback. */
export function invalidChatLoopConsumer(
  scope: LogicalScope,
  options: ChatLoopOptions,
  native: Operation<
    import("@standard-durability/core").Outcome<
      ChatLoopSample,
      import("@sweatpan.ts/chat").ChatSamplingError
    >,
    { readonly native: true }
  >,
) {
  return runChat(scope, {
    ...options,
    // @ts-expect-error Native instructions require host-side domain handling.
    sample: () => native,
  });
}

/** Progress callbacks also stay inside the Guest instruction algebra. */
export function invalidChatProgressConsumer(
  scope: LogicalScope,
  options: ChatLoopOptions,
  native: Operation<void, { readonly native: true }>,
) {
  return runChat(scope, {
    ...options,
    // @ts-expect-error Native publication belongs in a recorded effect's Host handler.
    event: () => native,
  });
}

/** Pull sources preserve both domain and logical ownership instructions. */
export function chatStreamConsumer(
  scope: LogicalScope,
  options: ChatStreamOptions,
): Stream<
  ChatLoopEvent,
  ChatLoopResult,
  import("@sweatpan.ts/core").CapabilityRequest | ScopeInstruction
> {
  return streamChat(scope, options);
}

/** The same pull helper accepts Guest logical ownership without native instructions. */
export function guestPullConsumer(scope: LogicalScope): Stream<string, number, ScopeInstruction> {
  return createPullStream<string, number, never, ScopeInstruction>(
    scope,
    () =>
      function* () {
        return { done: true, value: 1 };
      },
  );
}

/** Host policy facades compose through their operations without changing native yields. */
export function* chatSamplingConsumer<Y>(
  composition: Composition<Y>,
  model: ModelInfo,
  value: ChatLoopSample,
) {
  const models = createChatModel(composition, "model", {
    *select() {
      return model;
    },
  });
  const sampling = createChatSampling(composition, "sample", {
    model: models.operations,
    *sample() {
      return value;
    },
  });
  yield* sampling.around(limitChatRounds(3));
  return yield* sampling.operations.sample({ round: 0, history: [], tools: [] });
}
