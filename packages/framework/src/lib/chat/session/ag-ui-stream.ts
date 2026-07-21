import type { Channel, Operation, Stream } from "effection";
import { each } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ElicitRequestStreamEvent, StreamEvent, StreamResult } from "./streaming.ts";
import type { StreamEventEntry } from "./options.ts";

/**
 * Consume durable frames without translating their events. Every canonical
 * AG-UI event is forwarded unchanged to the state fold while this driver
 * derives the turn result needed by the session runtime.
 */
export function* consumeAgUiEventStream(
  eventStream: Stream<unknown, void>,
  events: Channel<ChatStateEvent, void>,
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<StreamResult> {
  let state = initialChatState;

  for (const rawFrame of yield* each(eventStream)) {
    const frame = rawFrame as { lsn: number; event: StreamEvent };
    onStreamEvent?.({
      lsn: frame.lsn,
      event: frame.event,
      phase: "live",
      receivedAt: Date.now(),
    });
    state = chatReducer(state, frame.event);
    yield* events.send(frame.event);
    if (frame.event.type === "RUN_ERROR") throw new Error(frame.event.message);
    yield* each.next();
  }

  const toolCalls = Object.values(state.toolCallDrafts).map((call) => ({
    id: call.id,
    name: call.name,
    arguments: (() => {
      try { return JSON.parse(call.arguments) as unknown; } catch { return call.arguments; }
    })(),
  }));
  const toolResults = state.messages
    .filter((message) => message.role === "tool" && message.tool_call_id)
    .map((message) => ({
      id: message.tool_call_id!,
      name: message.replay?.toolName ?? state.toolCallDrafts[message.tool_call_id!]?.name ?? "unknown",
      content: message.content,
    }));
  const assistantText = state.messages
    .filter((message) => message.role === "assistant" && !message.tool_calls?.length)
    .at(-1)?.content ?? "";
  const conversationState = {
    messages: state.messages,
    assistantContent: assistantText,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments:
        call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
          ? (call.arguments as Record<string, unknown>)
          : {},
    })),
    serverToolResults: toolResults.map((result) => ({
      ...result,
      isError: result.content.startsWith("Error:"),
    })),
    ...(state.replay ? { replay: state.replay } : {}),
  };

  const pendingElicitations: ElicitRequestStreamEvent[] = Object.values(state.pendingElicits)
    .flatMap((tracking) => tracking.elicitations)
    .filter((elicit) => elicit.status === "pending")
    .map((elicit) => ({
      type: "elicit_request",
      sessionId: elicit.sessionId,
      callId: elicit.callId,
      toolName: elicit.toolName,
      elicitId: elicit.elicitId,
      key: elicit.key,
      message: elicit.message,
      schema: elicit.schema,
    }));

  if (pendingElicitations.length > 0) {
    return { type: "elicit", pendingElicitations, conversationState };
  }
  return {
    type: "complete",
    text: assistantText,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
    conversationState,
  };
}
