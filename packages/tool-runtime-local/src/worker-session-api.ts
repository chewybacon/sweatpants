/**
 * Worker Session API
 *
 * Provides middleware-decoratable operations for worker session request/response
 * handling using Effection's experimental createApi.
 */

import { createApi } from "effection/experimental";
import { createQueue, type Operation } from "effection";
import type {
  WorkerElicitRequest,
  WorkerElicitResponse,
  WorkerMessage,
  WorkerSampleRequest,
  WorkerSampleResponse,
} from "@sweatpants/agent-sdk/transport/worker";
import type { ElicitExchangeCompletion, SampleExchangeCompletion } from "@sweatpants/agent-sdk";
import type { ExtendedMessage, ToolCallMessage } from "@sweatpants/tool-session/messages";
import { MODEL_CONTEXT_SCHEMA_KEY } from "@sweatpants/tool-session/mcp";
import { WorkerSessionStateContext } from "./worker-session-context.ts";

/**
 * Convert a WorkerMessage to an ExtendedMessage.
 *
 * Preserves tool call structure instead of flattening to strings:
 * - String content → Message
 * - Content blocks with tool_use → ToolCallMessage (OpenAI format)
 * - Content blocks with tool_result → ToolResultMessage (OpenAI format)
 * - Text-only content blocks → Message (joined text)
 */
function workerMessageToExtended(message: WorkerMessage): ExtendedMessage {
  // Simple string content → plain Message
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }

  const blocks = message.content;

  // Check for tool_use content blocks → ToolCallMessage
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    const textContent = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls: ToolCallMessage["toolCalls"] = [
      {
        id: toolUseBlocks[0]!.id,
        name: toolUseBlocks[0]!.name,
        arguments: toolUseBlocks[0]!.input,
      },
      ...toolUseBlocks.slice(1).map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input,
      })),
    ];
    return {
      role: "assistant",
      content: textContent,
      toolCalls,
    };
  }

  // Check for tool_result content blocks → ToolResultMessage
  const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
  if (toolResultBlocks.length > 0 && toolResultBlocks[0]) {
    const firstResult = toolResultBlocks[0];
    const resultText = firstResult.content.map((c) => c.text).join("");
    return {
      role: "tool",
      content: resultText,
      toolCallId: firstResult.toolUseId,
      isError: firstResult.isError === true,
    };
  }

  // Text-only content blocks → plain Message
  const textContent = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { role: message.role, content: textContent };
}

export const WorkerSessionApi = createApi("worker-session", {
  // ==========================================
  // Request side (worker → host)
  // ==========================================

  *handleElicitRequest(request: WorkerElicitRequest): Operation<WorkerElicitResponse> {
    const state = yield* WorkerSessionStateContext.expect();
    const elicitId = request.id;

    const queue = createQueue<ElicitExchangeCompletion<unknown>, void>();
    state.pendingElicitChannels.set(elicitId, queue);

    const schemaWithContext = request.context
      ? { ...request.schema, [MODEL_CONTEXT_SCHEMA_KEY]: request.context }
      : request.schema;

    yield* state.emitEvent({
      type: "elicit_request",
      elicitId,
      key: request.key,
      message: request.message,
      schema: schemaWithContext,
      ...(request.context !== undefined && { context: request.context }),
    });

    const result = yield* queue.next();

    state.pendingElicitChannels.delete(elicitId);

    if (result.done) {
      return {
        id: elicitId,
        type: "elicit",
        completion: { action: "cancel", reason: "worker elicitation channel closed" },
      };
    }

    state.setStatus("running");
    return { id: elicitId, type: "elicit", completion: result.value };
  },

  *handleSampleRequest(request: WorkerSampleRequest): Operation<WorkerSampleResponse> {
    const state = yield* WorkerSessionStateContext.expect();
    const sampleId = request.id;

    const queue = createQueue<SampleExchangeCompletion, void>();
    state.pendingSampleChannels.set(sampleId, queue);

    const messages: ExtendedMessage[] = request.messages.map(workerMessageToExtended);

    yield* state.emitEvent({
      type: "sample_request",
      sampleId,
      messages,
      ...(request.systemPrompt !== undefined && { systemPrompt: request.systemPrompt }),
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.modelPreferences !== undefined && { modelPreferences: request.modelPreferences }),
      ...(request.tools !== undefined && { tools: request.tools }),
      ...(request.toolChoice !== undefined && { toolChoice: request.toolChoice }),
      ...(request.schema !== undefined && { schema: request.schema }),
    });

    const result = yield* queue.next();

    state.pendingSampleChannels.delete(sampleId);

    if (result.done) {
      throw new Error(`Sample response channel closed before completion for ${sampleId}`);
    }

    state.setStatus("running");
    return { id: sampleId, type: "sample", completion: result.value };
  },

  // ==========================================
  // Response side (host → worker)
  // ==========================================

  *respondToElicit(elicitId: string, response: ElicitExchangeCompletion<unknown>): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect();
    const queue = state.pendingElicitChannels.get(elicitId);
    if (!queue) {
      throw new Error(`No pending elicit response queue for ${elicitId}`);
    }
    queue.add(response);
    queue.close(undefined);
    state.pendingElicitChannels.delete(elicitId);
  },

  *respondToSample(sampleId: string, response: SampleExchangeCompletion): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect();
    const queue = state.pendingSampleChannels.get(sampleId);
    if (!queue) {
      throw new Error(`No pending sample response queue for ${sampleId}`);
    }
    queue.add(response);
    queue.close(undefined);
    state.pendingSampleChannels.delete(sampleId);
  },
});

export const { handleElicitRequest, handleSampleRequest, respondToElicit, respondToSample } =
  WorkerSessionApi.operations;
