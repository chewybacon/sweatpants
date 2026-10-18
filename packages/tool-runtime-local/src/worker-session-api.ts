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
import {
  decodeChatMessage,
  type ChatMessage,
  type ChatMessagePart,
} from "@sweatpants/chat-contract";
import { WorkerSessionStateContext } from "./worker-session-context.ts";

/** Decode worker-owned message values into canonical Chat messages once. */
function workerMessagesToChatMessages(messages: readonly WorkerMessage[]): ChatMessage[] {
  const toolNames = new Map<string, string>();
  const output: ChatMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const path = `$.messages[${index}]`;
    if (typeof message.content === "string") {
      output.push(
        decodeChatMessage(
          message.role === "user"
            ? { role: "user", content: message.content }
            : { role: "assistant", content: [{ type: "text", text: message.content }] },
          path,
        ),
      );
      continue;
    }

    const blocks = message.content;
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    for (const call of toolUses) {
      toolNames.set(call.id, call.name);
    }
    const toolResults = blocks.filter((block) => block.type === "tool_result");
    if (message.role === "user" && toolUses.length > 0 && toolResults.length === 0) {
      throw new Error(`${path}: worker tool calls must be in an assistant message`);
    }
    if (toolResults.length > 0) {
      if (message.role !== "user" || toolResults.length !== blocks.length) {
        throw new Error(
          `${path}: worker tool results must be the complete content of a user message`,
        );
      }
      for (const [resultIndex, result] of toolResults.entries()) {
        const name = toolNames.get(result.toolUseId);
        if (!name) {
          throw new Error(
            `${path}.content[${resultIndex}]: worker tool result has no preceding call identity`,
          );
        }
        output.push(
          decodeChatMessage(
            {
              role: "tool",
              toolCallId: result.toolUseId,
              name,
              content: result.content.map((content) => ({ type: "text", text: content.text })),
              isError: result.isError === true,
            },
            `${path}.content[${resultIndex}]`,
          ),
        );
      }
      continue;
    }

    const parts: ChatMessagePart[] = [];
    for (const [blockIndex, block] of blocks.entries()) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          type: "tool-call",
          toolCall: {
            id: block.id,
            name: block.name,
            input: block.input,
            thoughtSignature: null,
          },
        });
      } else {
        throw new Error(`${path}.content[${blockIndex}]: unsupported worker content block`);
      }
    }
    output.push(
      decodeChatMessage(
        message.role === "user"
          ? { role: "user", content: parts }
          : { role: "assistant", content: parts },
        path,
      ),
    );
  }

  return output;
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

    yield* state.emitEvent({
      type: "elicit_request",
      elicitId,
      key: request.key,
      message: request.message,
      schema: request.schema,
      context: request.context,
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

    const messages = workerMessagesToChatMessages(request.messages);

    yield* state.emitEvent({
      type: "sample_request",
      sampleId,
      messages,
      systemPrompt: request.systemPrompt,
      maxTokens: request.maxTokens,
      modelPreferences: request.modelPreferences,
      tools: request.tools,
      toolChoice: request.toolChoice,
      schema: request.schema,
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
