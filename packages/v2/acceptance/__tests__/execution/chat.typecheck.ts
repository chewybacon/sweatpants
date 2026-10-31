import type { Composition, Operation } from "@standard-durability/core";
import {
  runChat,
  type ChatLoopOptions,
  type ChatLoopResult,
  prepareChatInference,
  createChatContext,
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
  options: ChatLoopOptions,
): Operation<ChatLoopResult, import("@sweatpan.ts/core").CapabilityRequest> {
  return runChat(options);
}

/** Host-native work cannot be passed directly into the Guest sampling callback. */
export function invalidChatLoopConsumer(
  options: ChatLoopOptions,
  native: Operation<import("@sweatpan.ts/chat").ChatLoopSample, { readonly native: true }>,
) {
  return runChat({
    ...options,
    // @ts-expect-error Native instructions require host-side domain handling.
    sample: () => native,
  });
}
