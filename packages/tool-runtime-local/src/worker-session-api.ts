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
} from "@sweatpants/core/transport/worker";
import type { WireElicitResult, ExtendedMessage, ToolCallMessage } from "@sweatpants/tool-session";
import { MODEL_CONTEXT_SCHEMA_KEY } from "@sweatpants/framework/chat";
import type { WireSampleResult } from "@sweatpants/tool-session";
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
    const toolCalls = toolUseBlocks.map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: b.input },
    }));
    return {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls as [ToolCallMessage["tool_calls"][0], ...ToolCallMessage["tool_calls"]],
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
      tool_call_id: firstResult.toolUseId,
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

    const queue = createQueue<WireElicitResult<unknown>, void>();
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
      return { id: elicitId, type: "elicit", action: "cancel" };
    }

    const rawResult = result.value;
    state.setStatus("running");

    return {
      id: elicitId,
      type: "elicit",
      action: rawResult.action,
      ...(rawResult.action === "accept" && { content: rawResult.content }),
      ...((rawResult.action === "decline" || rawResult.action === "cancel") &&
        "reason" in rawResult &&
        rawResult.reason !== undefined && { reason: rawResult.reason }),
    };
  },

  *handleSampleRequest(request: WorkerSampleRequest): Operation<WorkerSampleResponse> {
    const state = yield* WorkerSessionStateContext.expect();
    const sampleId = request.id;

    const queue = createQueue<WireSampleResult, void>();
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
      return {
        id: sampleId,
        type: "sample",
        status: "accepted",
        text: "",
      };
    }

    const rawResult = result.value;
    state.setStatus("running");

    const workerResponse: WorkerSampleResponse = {
      id: sampleId,
      type: "sample",
      status: "accepted",
      text: rawResult.text,
      ...(rawResult.model !== undefined && { model: rawResult.model }),
      ...(rawResult.stopReason !== undefined && { stopReason: rawResult.stopReason }),
      ...("parsed" in rawResult && rawResult.parsed !== undefined && { parsed: rawResult.parsed }),
      ...("parseError" in rawResult &&
        rawResult.parseError !== undefined && { parseError: rawResult.parseError }),
      ...("toolCalls" in rawResult &&
        rawResult.toolCalls !== undefined && { toolCalls: rawResult.toolCalls }),
    };

    return workerResponse;
  },

  // ==========================================
  // Response side (host → worker)
  // ==========================================

  *respondToElicit(elicitId: string, response: WireElicitResult<unknown>): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect();
    const queue = state.pendingElicitChannels.get(elicitId);
    if (!queue) {
      throw new Error(`No pending elicit response queue for ${elicitId}`);
    }
    queue.add(response);
    queue.close(undefined);
    state.pendingElicitChannels.delete(elicitId);
  },

  *respondToSample(sampleId: string, response: WireSampleResult): Operation<void> {
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
