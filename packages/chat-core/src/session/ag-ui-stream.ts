import type { Channel, Operation, Stream } from "effection";
import { each } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ElicitRequestStreamEvent, StreamEvent, StreamResult } from "./streaming.ts";
import type { StreamEventEntry } from "./options.ts";
import type { Json } from "@sweatpants/foundation";

interface RunToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Undecodable text survives verbatim; only the authored schema may reject it. */
function parseArguments(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

/**
 * Forward canonical AG-UI events unchanged while deriving only the current
 * run's result. Snapshot history remains in ConversationState but never leaks
 * into the current turn's text/tool result fields.
 */
export function* consumeAgUiEventStream(
  eventStream: Stream<unknown, void>,
  events: Channel<ChatStateEvent, void>,
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<StreamResult> {
  let state = initialChatState;
  let runStarted = false;
  let terminalSeen = false;
  let runError: Error | null = null;
  let assistantText = "";
  const toolCalls = new Map<string, RunToolCall>();
  const toolResults = new Map<
    string,
    { id: string; name: string; content: string; isError: boolean }
  >();

  for (const rawFrame of yield* each(eventStream)) {
    const frame = rawFrame as { lsn: number; event: StreamEvent };
    const event = frame.event;
    onStreamEvent?.({ lsn: frame.lsn, event, phase: "live", receivedAt: Date.now() });

    if (event.type === "RUN_STARTED") {
      runStarted = true;
      terminalSeen = false;
      runError = null;
      assistantText = "";
      toolCalls.clear();
      toolResults.clear();
    } else if (runStarted && !terminalSeen) {
      switch (event.type) {
        case "TEXT_MESSAGE_CONTENT":
          assistantText += event.delta;
          break;
        case "TOOL_CALL_START":
          // Text before a tool call belongs to the assistant tool-host. Only
          // post-tool text is the final assistant response for this turn.
          assistantText = "";
          toolCalls.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolCallName,
            arguments: "",
          });
          break;
        case "TOOL_CALL_ARGS": {
          const call = toolCalls.get(event.toolCallId);
          if (call) {
            toolCalls.set(event.toolCallId, { ...call, arguments: call.arguments + event.delta });
          }
          break;
        }
        case "TOOL_CALL_RESULT": {
          const name = event.toolCallName ?? toolCalls.get(event.toolCallId)?.name;
          if (!name) {
            throw new Error(`Tool result "${event.toolCallId}" has no settled tool name`);
          }
          toolResults.set(event.toolCallId, {
            id: event.toolCallId,
            name,
            content: event.content,
            isError: event.isError === true || event.error !== undefined,
          });
          break;
        }
        case "RUN_FINISHED":
          terminalSeen = true;
          break;
        case "RUN_ERROR":
          terminalSeen = true;
          runError = new Error(event.message);
          break;
        default:
          break;
      }
    }

    state = chatReducer(state, event);
    yield* events.send(event);
    yield* each.next();
  }

  if (!runStarted) {
    throw new Error("AG-UI stream ended before RUN_STARTED");
  }
  if (!terminalSeen) {
    throw new Error("AG-UI stream ended before RUN_FINISHED or RUN_ERROR");
  }
  if (runError) {
    throw runError;
  }

  const currentToolCalls = [...toolCalls.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: parseArguments(call.arguments),
  }));
  const currentToolResults = [...toolResults.values()];
  const conversationState = {
    messages: state.messages,
    assistantContent: assistantText,
    toolCalls: currentToolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    serverToolResults: currentToolResults,
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
    ...(currentToolCalls.length > 0 ? { toolCalls: currentToolCalls } : {}),
    ...(currentToolResults.length > 0 ? { toolResults: currentToolResults } : {}),
    conversationState,
  };
}
