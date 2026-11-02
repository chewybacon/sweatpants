import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { LogicalScope, ScopeInstruction } from "@sweatpan.ts/execution";
import { createPullStream, type Stream } from "@sweatpan.ts/runtime";
import type { ChatToolCall, ModelResponse } from "@sweatpan.ts/providers";
import type {
  ChatHistoryMessage,
  ChatLoopEvent,
  ChatLoopOptions,
  ChatLoopResult,
  ChatStreamOptions,
  ChatToolResult,
} from "./contracts.ts";
import { assertCompleteHistory } from "./history.ts";

/**
 * Pull-driven Guest chat. One subscription advances sequential domain work until
 * its next detached progress value. No next means no model/tool advancement.
 * Scope exit invalidates the subscription. Host disposal discards this incarnation;
 * recovery reconstructs it. Record each event before pulling again for durable
 * progress. Neither stream acquisition nor event delivery itself records anything.
 * Fresh streams are independent runs; never use UI readers to drive this stream.
 */
export function streamChat(
  scope: LogicalScope,
  options: ChatStreamOptions,
): Stream<ChatLoopEvent, ChatLoopResult, CapabilityRequest | ScopeInstruction> {
  return createPullStream<ChatLoopEvent, ChatLoopResult, CapabilityRequest, ScopeInstruction>(
    scope,
    () => {
      assertCompleteHistory(options.history);
      const history: ChatHistoryMessage[] = structuredClone([...options.history]);
      const catalog = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
      if (
        catalog.size !== options.tools.length ||
        options.tools.some((tool) => !tool.definition.name.trim())
      ) {
        throw new Error("Chat catalog requires unique nonempty names");
      }
      const seen = new Set<string>();
      for (const message of history) {
        if (message.role === "assistant") {
          for (const part of message.content) {
            if (part.type === "tool-call") {
              seen.add(part.toolCall.id);
            }
          }
        }
      }
      let round = 0;
      let phase: "sample" | "tools" | "call" | "batch" | "batch-results" = "sample";
      let batchResults: readonly ChatToolResult[] = [];
      let response: ModelResponse;
      let calls: ChatToolCall[] = [];
      let index = 0;
      return function* next(): Operation<
        IteratorResult<ChatLoopEvent, ChatLoopResult>,
        CapabilityRequest
      > {
        while (true) {
          if (phase === "sample") {
            const sampled = yield* options.sample({
              round,
              history: structuredClone(history),
              tools: structuredClone(options.tools.map((tool) => tool.definition)),
            });
            if (!sampled.ok) {
              throw new Error(sampled.error.message);
            }
            const model = structuredClone(sampled.value.model);
            if (sampled.value.response.errorMessage) {
              throw new Error(sampled.value.response.errorMessage);
            }
            response = structuredClone(sampled.value.response);
            calls = response.message.content.flatMap((part) =>
              part.type === "tool-call" ? [part.toolCall] : [],
            );
            // No prefix of a malformed batch is executed or emitted.
            for (const call of calls) {
              if (!call.id.trim() || seen.has(call.id)) {
                throw new Error("Duplicate or empty tool call identity");
              }
              if (!catalog.has(call.name)) {
                throw new Error(`Tool is not in chat catalog: ${call.name}`);
              }
              seen.add(call.id);
            }
            history.push({ ...response.message, model });
            phase = "tools";
            index = 0;
            return {
              done: false,
              value: {
                type: "assistant",
                round,
                message: structuredClone({ ...response.message, model }),
              },
            };
          }
          if (phase === "tools") {
            if (calls.length === 0) {
              return { done: true, value: { response: response!, history, rounds: round + 1 } };
            }
            if (index === calls.length) {
              round++;
              phase = "sample";
              continue;
            }
            if (options.executeTools) {
              phase = "batch";
              return {
                done: false,
                value: { type: "tool-batch-started", round, calls: structuredClone(calls) },
              };
            }
            phase = "call";
            return {
              done: false,
              value: { type: "tool-started", round, call: structuredClone(calls[index]!) },
            };
          }
          if (phase === "batch") {
            const results = yield* options.executeTools!(structuredClone(calls));
            const expected = new Set(calls.map((call) => call.id));
            const byId = new Map<string, ChatToolResult>();
            for (const result of results) {
              if (!expected.has(result.toolCallId) || byId.has(result.toolCallId)) {
                throw new Error("Unknown or duplicate batch result identity");
              }
              byId.set(result.toolCallId, structuredClone(result));
            }
            if (byId.size !== calls.length) {
              throw new Error("Missing batch result identity");
            }
            batchResults = calls.map((call) => byId.get(call.id)!);
            phase = "batch-results";
          }
          const call = calls[index]!;
          const batched = phase === "batch-results";
          function* invoke() {
            const tool = catalog.get(call.name)!;
            if (!("call" in tool)) {
              throw new Error("Sequential tool callback missing");
            }
            return yield* tool.call(structuredClone(call));
          }
          const result = batched ? batchResults[index]! : yield* invoke();
          history.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: structuredClone(result.content),
            isError: result.isError,
          });
          index++;
          phase = batched && index < calls.length ? "batch-results" : "tools";
          if (index === calls.length) {
            batchResults = [];
          }
          return {
            done: false,
            value: {
              type: "tool-completed",
              round,
              call: structuredClone(call),
              content: structuredClone(result.content),
              isError: result.isError,
            },
          };
        }
      };
    },
  );
}

/** Drain streamChat in a child logical scope. Callback handling completes before
 * the next pull. Callback failure exits that scope; delivery exceptions propagate.
 * Omitting the callback drains progress without recording it. */
export function* runChat(
  scope: LogicalScope,
  options: ChatLoopOptions,
): Operation<ChatLoopResult, CapabilityRequest | ScopeInstruction> {
  return yield* scope.scoped(function* (owner) {
    const events = yield* streamChat(owner, options);
    while (true) {
      const item = yield* events.next();
      if (item.done) {
        return item.value;
      }
      if (options.event) {
        yield* options.event(item.value);
      }
    }
  });
}
