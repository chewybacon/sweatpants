import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatHistoryMessage, ChatLoopOptions, ChatLoopResult } from "./contracts.ts";
import { assertCompleteHistory } from "./history.ts";

/**
 * Sequential catalog-driven model/tool rounds inside a Guest. Replay comes from the
 * enclosing journal, not this function. Validate the entire batch's identities and
 * catalog membership before calling any tool. Host schemas still validate inputs.
 * Calls may park through ordinary owned-tool hosting; delivery exceptions escape.
 */
export function* runChat(options: ChatLoopOptions): Operation<ChatLoopResult, CapabilityRequest> {
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1) {
    throw new Error("Invalid chat round limit");
  }
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
  for (let round = 0; round < options.maxRounds; round++) {
    const model = structuredClone(options.model(round));
    const sample = yield* options.sample({
      model: structuredClone(model),
      history: structuredClone(history),
      tools: structuredClone(options.tools.map((tool) => tool.definition)),
    });
    if (
      sample.model.id !== model.id ||
      sample.model.api !== model.api ||
      sample.model.provider !== model.provider
    ) {
      throw new Error("Sample differs from selected model");
    }
    if (sample.response.errorMessage) {
      throw new Error(sample.response.errorMessage);
    }
    const response = structuredClone(sample.response);
    const calls = response.message.content.flatMap((part) =>
      part.type === "tool-call" ? [part.toolCall] : [],
    );
    // Validate all names/identities first; no prefix of a malformed batch is executed.
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
    if (calls.length === 0) {
      return { response, history, rounds: round + 1 };
    }
    if (round + 1 === options.maxRounds) {
      throw new Error("Chat round limit reached");
    }
    for (const call of calls) {
      const result = yield* catalog.get(call.name)!.call(structuredClone(call));
      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: structuredClone(result.content),
        isError: result.isError,
      });
    }
  }
  throw new Error("Chat round limit reached");
}
