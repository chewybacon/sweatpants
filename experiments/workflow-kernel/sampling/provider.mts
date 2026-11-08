import type {
  ModelProvider,
  ModelStreamEvent,
  ModelRequest,
  ModelResponse,
} from "../../../packages/v2/providers/src/index.ts";
import type { Stream } from "../../../packages/v2/runtime/src/index.ts";
import type { SampleRequest, SampleResponse } from "./contracts.mts";

export type SampleModel = SampleResponse["model"];
/** Stream-first adapter over the existing provider. No model selection, retry,
 * hidden history, recording, or schema synthesis happens here. */
export function sampleStream<Y>(
  provider: ModelProvider<Y>,
  model: SampleModel,
  request: SampleRequest,
): Stream<ModelStreamEvent, SampleResponse, Y> {
  const messages: ModelRequest["context"]["messages"][number][] = [];
  if (request.systemPrompt !== undefined) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  for (const message of request.history ?? []) {
    messages.push(
      message.role === "user"
        ? { role: "user", content: message.content }
        : { role: "assistant", content: [{ type: "text", text: message.content }] },
    );
  }
  messages.push({ role: "user", content: request.prompt });
  function complete(response: ModelResponse): SampleResponse {
    if (
      response.errorMessage ||
      ["error", "aborted", "length"].includes(response.stopReason ?? "")
    ) {
      throw new Error("Sample did not complete successfully");
    }
    if (
      !response.source ||
      response.source.model !== model.id ||
      response.source.provider !== model.provider ||
      response.source.api !== model.api
    ) {
      throw new Error("Sample differs from host-selected model");
    }
    if (response.message.content.some((part) => !["text", "reasoning"].includes(part.type))) {
      throw new Error("Text sampling returned unsupported content");
    }
    return {
      text: response.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      model: { ...model },
      responseId: response.responseId,
    };
  }
  return {
    *[Symbol.iterator]() {
      const source = yield* provider.stream({
        context: { messages, tools: [] },
        options: { toolChoice: "none", maxTokens: request.maxTokens ?? 4096 },
      });
      return {
        *next() {
          const item = yield* source.next();
          return item.done ? { done: true as const, value: complete(item.value) } : item;
        },
      };
    },
  };
}
