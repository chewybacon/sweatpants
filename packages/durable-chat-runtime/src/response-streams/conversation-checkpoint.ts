import { EventType, type AGUIEvent } from "@ag-ui/core";
import { aguiEventParser } from "@sweatpants/chat-core";

type StreamEvent = AGUIEvent;

const MAX_CHECKPOINT_EVENTS = 100_000;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_MESSAGES = 256;
const MAX_TOOL_CALLS = 128;
const MAX_TOOLS = 256;
const MAX_CONTEXT_ENTRIES = 256;
const MAX_RESUME_ENTRIES = 256;
const MAX_INTERRUPTS = 64;
const MAX_ID_LENGTH = 1_024;
const checkpointEncoder = new TextEncoder();

type JsonRecord = Record<string, unknown>;

function checkpointError(message: string, cause?: unknown): ConversationCheckpointError {
  return new ConversationCheckpointError(message, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw checkpointError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function boundedString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw checkpointError(`${path} must be a bounded non-empty string`);
  }
}

const baseEventKeys = new Set(["type", "timestamp", "rawEvent"]);
const eventKeys: ReadonlyMap<EventType, ReadonlySet<string>> = new Map([
  [EventType.TEXT_MESSAGE_START, new Set(["messageId", "role", "name"])],
  [EventType.TEXT_MESSAGE_CONTENT, new Set(["messageId", "delta"])],
  [EventType.TEXT_MESSAGE_END, new Set(["messageId"])],
  [EventType.TEXT_MESSAGE_CHUNK, new Set(["messageId", "delta", "role"])],
  [EventType.TOOL_CALL_START, new Set(["toolCallId", "toolCallName", "parentMessageId"])],
  [EventType.TOOL_CALL_ARGS, new Set(["toolCallId", "delta"])],
  [EventType.TOOL_CALL_END, new Set(["toolCallId"])],
  [EventType.TOOL_CALL_CHUNK, new Set(["toolCallId", "toolCallName", "parentMessageId", "delta"])],
  [EventType.TOOL_CALL_RESULT, new Set(["messageId", "toolCallId", "content", "role"])],
  [EventType.STATE_SNAPSHOT, new Set(["snapshot"])],
  [EventType.STATE_DELTA, new Set(["delta"])],
  [EventType.MESSAGES_SNAPSHOT, new Set(["messages"])],
  [EventType.ACTIVITY_SNAPSHOT, new Set(["messageId", "activityType", "content", "replace"])],
  [EventType.ACTIVITY_DELTA, new Set(["messageId", "activityType", "patch"])],
  [EventType.RAW, new Set(["event", "source"])],
  [EventType.CUSTOM, new Set(["name", "value"])],
  [EventType.RUN_STARTED, new Set(["threadId", "runId", "parentRunId", "input"])],
  [EventType.RUN_FINISHED, new Set(["threadId", "runId", "result", "outcome"])],
  [EventType.RUN_ERROR, new Set(["message", "code"])],
  [EventType.STEP_STARTED, new Set(["stepName"])],
  [EventType.STEP_FINISHED, new Set(["stepName"])],
  [EventType.REASONING_START, new Set([])],
  [EventType.REASONING_MESSAGE_START, new Set(["messageId", "role", "name"])],
  [EventType.REASONING_MESSAGE_CONTENT, new Set(["messageId", "delta"])],
  [EventType.REASONING_MESSAGE_END, new Set(["messageId"])],
  [EventType.REASONING_MESSAGE_CHUNK, new Set(["messageId", "delta"])],
  [EventType.REASONING_END, new Set([])],
  [EventType.REASONING_ENCRYPTED_VALUE, new Set(["subtype", "entityId", "encryptedValue"])],
]);

function assertKnownEventKeys(input: JsonRecord): void {
  const type = input["type"];
  if (typeof type !== "string") {
    throw checkpointError("event.type must be a string");
  }
  const allowed = eventKeys.get(type as EventType);
  if (!allowed) {
    throw checkpointError(`event type ${type} is not persisted by this checkpoint codec`);
  }
  for (const key of Object.keys(input)) {
    if (!baseEventKeys.has(key) && !allowed.has(key)) {
      throw checkpointError(`event field ${key} is not part of the official AG-UI event`);
    }
  }
}

function assertMessageKeys(input: JsonRecord): void {
  const role = input["role"];
  const keysByRole: Record<string, readonly string[]> = {
    developer: ["id", "role", "content", "name", "encryptedValue"],
    system: ["id", "role", "content", "name", "encryptedValue"],
    user: ["id", "role", "content", "name", "encryptedValue"],
    assistant: ["id", "role", "content", "name", "encryptedValue", "toolCalls"],
    tool: ["id", "role", "content", "toolCallId", "error", "encryptedValue"],
    activity: ["id", "role", "activityType", "content"],
    reasoning: ["id", "role", "content", "encryptedValue"],
  };
  const allowed = keysByRole[typeof role === "string" ? role : ""];
  if (!allowed) {
    throw checkpointError("message.role is not an official AG-UI role");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw checkpointError(`message field ${key} is not part of the official AG-UI message`);
    }
  }
  boundedString(input["id"], "message.id");

  if (role === "assistant" && Array.isArray(input["toolCalls"])) {
    if (input["toolCalls"].length > MAX_TOOL_CALLS) {
      throw checkpointError("message.toolCalls exceeds the checkpoint limit");
    }
    for (const call of input["toolCalls"]) {
      const toolCall = record(call, "message.toolCalls[]");
      for (const key of Object.keys(toolCall)) {
        if (!["id", "type", "function", "encryptedValue"].includes(key)) {
          throw checkpointError(`tool call field ${key} is not official AG-UI`);
        }
      }
    }
  }
}

function assertMessageSnapshot(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_MESSAGES) {
    throw checkpointError("MESSAGES_SNAPSHOT.messages exceeds the checkpoint limit");
  }
  for (const entry of value) {
    const input = record(entry, "MESSAGES_SNAPSHOT.messages[]");
    assertMessageKeys(input);
  }
}

function assertBoundedRunInput(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const input = record(value, "RUN_STARTED.input");
  if (Array.isArray(input["messages"])) {
    if (input["messages"].length > MAX_SNAPSHOT_MESSAGES) {
      throw checkpointError("RUN_STARTED.input.messages exceeds the checkpoint limit");
    }
    assertMessageSnapshot(input["messages"]);
  }
  if (Array.isArray(input["tools"]) && input["tools"].length > MAX_TOOLS) {
    throw checkpointError("RUN_STARTED.input.tools exceeds the checkpoint limit");
  }
  if (Array.isArray(input["context"]) && input["context"].length > MAX_CONTEXT_ENTRIES) {
    throw checkpointError("RUN_STARTED.input.context exceeds the checkpoint limit");
  }
  if (Array.isArray(input["resume"]) && input["resume"].length > MAX_RESUME_ENTRIES) {
    throw checkpointError("RUN_STARTED.input.resume exceeds the checkpoint limit");
  }
}

function assertBoundedOutcome(value: unknown): void {
  const outcome = record(value, "RUN_FINISHED.outcome");
  if (outcome["type"] === "interrupt") {
    if (!Array.isArray(outcome["interrupts"]) || outcome["interrupts"].length > MAX_INTERRUPTS) {
      throw checkpointError("RUN_FINISHED.outcome.interrupts exceeds the checkpoint limit");
    }
  }
}

function validateCheckpointEvent(value: unknown): StreamEvent {
  const input = record(value, "event");
  assertKnownEventKeys(input);
  const parsed = aguiEventParser.parse(input);
  if (!parsed.ok) {
    throw checkpointError(parsed.issues[0]?.message ?? "event is not a valid official AG-UI event");
  }
  const event = parsed.value;
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    assertMessageSnapshot(event.messages);
  } else if (event.type === EventType.RUN_STARTED) {
    assertBoundedRunInput(event.input);
  } else if (event.type === EventType.RUN_FINISHED && event.outcome !== undefined) {
    assertBoundedOutcome(event.outcome);
  }
  return event;
}

function assertCheckpointSize(encoded: string): void {
  if (checkpointEncoder.encode(encoded).byteLength > MAX_CHECKPOINT_BYTES) {
    throw checkpointError("Conversation checkpoint exceeds the size limit");
  }
}

export class ConversationCheckpointError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationCheckpointError";
  }
}

/** Compile-time drift tripwire: checkpoint events are the official AG-UI union. */
export type _DecodeDrift = AGUIEvent extends StreamEvent ? true : never;

export function encodeConversationCheckpoint(events: readonly StreamEvent[]): string {
  try {
    if (events.length > MAX_CHECKPOINT_EVENTS) {
      throw checkpointError("Conversation checkpoint contains too many events");
    }
    const validated = events.map((event) => validateCheckpointEvent(event));
    const encoded = JSON.stringify({ version: 1, events: JSON.parse(JSON.stringify(validated)) });
    assertCheckpointSize(encoded);
    return encoded;
  } catch (error) {
    if (error instanceof ConversationCheckpointError) {
      throw error;
    }
    throw checkpointError("Conversation checkpoint cannot be encoded", error);
  }
}

export function decodeConversationCheckpoint(raw: string): StreamEvent[] {
  try {
    assertCheckpointSize(raw);
    const envelope = record(JSON.parse(raw), "checkpoint");
    for (const key of Object.keys(envelope)) {
      if (key !== "version" && key !== "events") {
        throw checkpointError(`Conversation checkpoint field ${key} is not supported`);
      }
    }
    if (envelope["version"] !== 1) {
      throw checkpointError("Conversation checkpoint version is unsupported");
    }
    const events = envelope["events"];
    if (!Array.isArray(events) || events.length > MAX_CHECKPOINT_EVENTS) {
      throw checkpointError("Conversation checkpoint events are invalid");
    }
    return events.map(validateCheckpointEvent);
  } catch (error) {
    if (error instanceof ConversationCheckpointError) {
      throw error;
    }
    throw checkpointError("Conversation checkpoint is malformed", error);
  }
}
