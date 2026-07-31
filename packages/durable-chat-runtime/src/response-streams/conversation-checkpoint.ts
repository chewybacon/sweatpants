import { z } from "zod";
import type {
  AgUiMessage,
  AgUiToolCall,
  ChatSessionStreamEvent as StreamEvent,
  ConversationReplayState,
  ToolExecutionTrace,
} from "@sweatpants/chat-core";
import type {
  ToolParameterValidationErrorPayload,
  ToolParameterValidationIssue,
} from "@sweatpants/agent-sdk/tool";

const MAX_CHECKPOINT_EVENTS = 100_000;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 64 * 1_024;
const MAX_TRACE_ENTRIES = 128;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const textSchema = z.string().max(MAX_TEXT_LENGTH);
const jsonObjectSchema = z.record(z.string().max(MAX_ID_LENGTH), z.json());

const functionCallSchema = z.object({ name: idSchema, arguments: textSchema }).strict();

const toolCallSchema: z.ZodType<AgUiToolCall> = z
  .object({
    id: idSchema,
    type: z.literal("function"),
    function: functionCallSchema,
  })
  .strict();

const developerMessageSchema = z
  .object({ id: idSchema, role: z.literal("developer"), content: textSchema })
  .strict()
  .transform((value): Extract<AgUiMessage, { role: "developer" }> => value);
const systemMessageSchema = z
  .object({ id: idSchema, role: z.literal("system"), content: textSchema })
  .strict()
  .transform((value): Extract<AgUiMessage, { role: "system" }> => value);
const userMessageSchema = z
  .object({ id: idSchema, role: z.literal("user"), content: textSchema })
  .strict()
  .transform((value): Extract<AgUiMessage, { role: "user" }> => value);
const assistantMessageSchema = z
  .object({
    id: idSchema,
    role: z.literal("assistant"),
    content: textSchema.optional(),
    toolCalls: z.array(toolCallSchema).max(MAX_CHECKPOINT_EVENTS).optional(),
  })
  .strict()
  .transform(
    (value): Extract<AgUiMessage, { role: "assistant" }> => ({
      id: value.id,
      role: "assistant",
      ...(value.content !== undefined ? { content: value.content } : {}),
      ...(value.toolCalls !== undefined ? { toolCalls: value.toolCalls } : {}),
    }),
  );
const toolMessageSchema = z
  .object({
    id: idSchema,
    role: z.literal("tool"),
    content: textSchema,
    toolCallId: idSchema,
    name: idSchema.optional(),
    error: textSchema.optional(),
  })
  .strict()
  .transform(
    (value): Extract<AgUiMessage, { role: "tool" }> => ({
      id: value.id,
      role: "tool",
      content: value.content,
      toolCallId: value.toolCallId,
      ...(value.name !== undefined ? { name: value.name } : {}),
      ...(value.error !== undefined ? { error: value.error } : {}),
    }),
  );
const activityMessageSchema = z
  .object({
    id: idSchema,
    role: z.literal("activity"),
    activityType: idSchema,
    content: jsonObjectSchema,
  })
  .strict()
  .transform((value): Extract<AgUiMessage, { role: "activity" }> => value);
const reasoningMessageSchema = z
  .object({ id: idSchema, role: z.literal("reasoning"), content: textSchema })
  .strict()
  .transform((value): Extract<AgUiMessage, { role: "reasoning" }> => value);

const agUiMessageSchema: z.ZodType<AgUiMessage> = z.union([
  developerMessageSchema,
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
  activityMessageSchema,
  reasoningMessageSchema,
]);

const runStartedEventSchema = z.object({
  type: z.literal("RUN_STARTED"),
  threadId: idSchema,
  runId: idSchema,
  parentRunId: idSchema.optional(),
  input: z
    .object({
      threadId: idSchema,
      runId: idSchema,
      parentRunId: idSchema.optional(),
      state: z.json(),
      messages: z.array(agUiMessageSchema).max(MAX_CHECKPOINT_EVENTS),
      tools: z
        .array(
          z
            .object({
              name: idSchema,
              description: textSchema,
              parameters: z.json(),
            })
            .strict(),
        )
        .max(MAX_CHECKPOINT_EVENTS),
      context: z
        .array(z.object({ description: textSchema, value: textSchema }).strict())
        .max(MAX_CHECKPOINT_EVENTS),
      forwardedProps: z.json(),
      resume: z
        .array(
          z
            .object({
              interruptId: idSchema,
              status: z.enum(["resolved", "cancelled"]),
              payload: z.json().optional(),
            })
            .strict(),
        )
        .max(MAX_CHECKPOINT_EVENTS)
        .optional(),
    })
    .strict()
    .optional(),
});
type RunStartedEvent = Extract<StreamEvent, { type: "RUN_STARTED" }>;
const runStartedSchema: z.ZodType<RunStartedEvent> = runStartedEventSchema
  .strict()
  .transform((value) => ({
    type: "RUN_STARTED" as const,
    threadId: value.threadId,
    runId: value.runId,
    ...(value.parentRunId !== undefined ? { parentRunId: value.parentRunId } : {}),
    ...(value.input !== undefined
      ? {
          input: {
            threadId: value.input.threadId,
            runId: value.input.runId,
            ...(value.input.parentRunId !== undefined
              ? { parentRunId: value.input.parentRunId }
              : {}),
            state: value.input.state,
            messages: value.input.messages,
            tools: value.input.tools,
            context: value.input.context,
            forwardedProps: value.input.forwardedProps,
            ...(value.input.resume !== undefined ? { resume: value.input.resume } : {}),
          },
        }
      : {}),
  }));

const interruptSchema = z
  .object({
    id: idSchema,
    reason: idSchema,
    message: textSchema.optional(),
    toolCallId: idSchema.optional(),
    responseSchema: jsonObjectSchema.optional(),
    expiresAt: textSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
type RunFinishedEvent = Extract<StreamEvent, { type: "RUN_FINISHED" }>;
type RunFinishedInterrupt = Extract<
  NonNullable<RunFinishedEvent["outcome"]>,
  { type: "interrupt" }
>;
const interruptOutcomeSchema = z
  .object({
    type: z.literal("interrupt"),
    interrupts: z.array(interruptSchema).max(MAX_CHECKPOINT_EVENTS),
  })
  .strict()
  .transform(
    (value): RunFinishedInterrupt => ({
      type: "interrupt",
      interrupts: value.interrupts.map((interrupt) => ({
        id: interrupt.id,
        reason: interrupt.reason,
        ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
        ...(interrupt.toolCallId !== undefined ? { toolCallId: interrupt.toolCallId } : {}),
        ...(interrupt.responseSchema !== undefined
          ? { responseSchema: interrupt.responseSchema }
          : {}),
        ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
        ...(interrupt.metadata !== undefined ? { metadata: interrupt.metadata } : {}),
      })),
    }),
  );
const runFinishedOutcomeSchema = z.union([
  z.object({ type: z.literal("success") }).strict(),
  interruptOutcomeSchema,
]);
const runFinishedSchema: z.ZodType<RunFinishedEvent> = z
  .object({
    type: z.literal("RUN_FINISHED"),
    threadId: idSchema,
    runId: idSchema,
    result: z.json().optional(),
    outcome: runFinishedOutcomeSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    type: "RUN_FINISHED" as const,
    threadId: value.threadId,
    runId: value.runId,
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
  }));

const runErrorSchema: z.ZodType<Extract<StreamEvent, { type: "RUN_ERROR" }>> = z
  .object({ type: z.literal("RUN_ERROR"), message: textSchema, code: idSchema.optional() })
  .strict()
  .transform((value) => ({
    type: "RUN_ERROR" as const,
    message: value.message,
    ...(value.code !== undefined ? { code: value.code } : {}),
  }));

const messagesSnapshotSchema: z.ZodType<Extract<StreamEvent, { type: "MESSAGES_SNAPSHOT" }>> = z
  .object({
    type: z.literal("MESSAGES_SNAPSHOT"),
    messages: z.array(agUiMessageSchema).max(MAX_CHECKPOINT_EVENTS),
  })
  .strict();

const replayEmissionSchema = z
  .object({
    order: z.number().int().nonnegative(),
    emissionId: idSchema,
    sourceInterruptId: idSchema.optional(),
    componentKey: idSchema,
    props: jsonObjectSchema,
    response: z.json().optional(),
    timestamp: z.number().finite(),
  })
  .strict()
  .transform((value): ToolExecutionTrace["emissions"][number] => ({
    order: value.order,
    emissionId: value.emissionId,
    ...(value.sourceInterruptId !== undefined
      ? { sourceInterruptId: value.sourceInterruptId }
      : {}),
    componentKey: value.componentKey,
    props: value.props,
    ...(value.response !== undefined ? { response: value.response } : {}),
    timestamp: value.timestamp,
  }));
const replayTraceSchema: z.ZodType<ToolExecutionTrace> = z
  .object({
    version: z.literal(1),
    emissions: z.array(replayEmissionSchema).max(MAX_TRACE_ENTRIES),
    startedAt: z.number().finite(),
    completedAt: z.number().finite(),
  })
  .strict();
const replayStateSchema: z.ZodType<ConversationReplayState> = z
  .object({
    toolTraces: z
      .array(z.object({ callId: idSchema, toolName: idSchema, trace: replayTraceSchema }).strict())
      .max(MAX_CHECKPOINT_EVENTS),
  })
  .strict();

type StateSnapshotEvent = Extract<StreamEvent, { type: "STATE_SNAPSHOT" }>;
const stateSnapshotSchema: z.ZodType<StateSnapshotEvent> = z
  .object({
    type: z.literal("STATE_SNAPSHOT"),
    snapshot: z
      .object({
        replay: replayStateSchema.optional(),
        pendingClientActions: z
          .array(
            z
              .object({
                toolCallId: idSchema,
                toolName: idSchema,
                kind: z.literal("elicit"),
                sessionId: idSchema,
                elicitId: idSchema,
                key: idSchema,
                message: textSchema,
                schema: jsonObjectSchema,
              })
              .strict(),
          )
          .max(MAX_CHECKPOINT_EVENTS)
          .optional(),
      })
      .strict()
      .transform((value) => ({
        ...(value.replay !== undefined ? { replay: value.replay } : {}),
        ...(value.pendingClientActions !== undefined
          ? { pendingClientActions: value.pendingClientActions }
          : {}),
      })),
  })
  .strict();

const textStartSchema: z.ZodType<Extract<StreamEvent, { type: "TEXT_MESSAGE_START" }>> = z
  .object({
    type: z.literal("TEXT_MESSAGE_START"),
    messageId: idSchema,
    role: z.enum(["assistant", "user", "system", "developer"]),
  })
  .strict();
const textContentSchema: z.ZodType<Extract<StreamEvent, { type: "TEXT_MESSAGE_CONTENT" }>> = z
  .object({ type: z.literal("TEXT_MESSAGE_CONTENT"), messageId: idSchema, delta: textSchema })
  .strict();
const textEndSchema: z.ZodType<Extract<StreamEvent, { type: "TEXT_MESSAGE_END" }>> = z
  .object({ type: z.literal("TEXT_MESSAGE_END"), messageId: idSchema })
  .strict();
const toolCallStartSchema: z.ZodType<Extract<StreamEvent, { type: "TOOL_CALL_START" }>> = z
  .object({
    type: z.literal("TOOL_CALL_START"),
    toolCallId: idSchema,
    toolCallName: idSchema,
    parentMessageId: idSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    type: "TOOL_CALL_START" as const,
    toolCallId: value.toolCallId,
    toolCallName: value.toolCallName,
    ...(value.parentMessageId !== undefined ? { parentMessageId: value.parentMessageId } : {}),
  }));
const toolCallArgsSchema: z.ZodType<Extract<StreamEvent, { type: "TOOL_CALL_ARGS" }>> = z
  .object({ type: z.literal("TOOL_CALL_ARGS"), toolCallId: idSchema, delta: textSchema })
  .strict();
const toolCallEndSchema: z.ZodType<Extract<StreamEvent, { type: "TOOL_CALL_END" }>> = z
  .object({ type: z.literal("TOOL_CALL_END"), toolCallId: idSchema })
  .strict();

const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string().max(MAX_ID_LENGTH), z.number().int()])).max(256),
    message: textSchema,
    code: idSchema.optional(),
    expected: z.json().optional(),
    received: z.json().optional(),
  })
  .strict()
  .transform(
    (value): ToolParameterValidationIssue => ({
      path: value.path,
      message: value.message,
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.expected !== undefined ? { expected: value.expected } : {}),
      ...(value.received !== undefined ? { received: value.received } : {}),
    }),
  );
const validationErrorSchema: z.ZodType<ToolParameterValidationErrorPayload> = z
  .object({
    code: z.literal("TOOL_PARAMETER_VALIDATION_FAILED"),
    toolName: idSchema,
    callId: idSchema,
    message: textSchema,
    issues: z.array(validationIssueSchema).max(256),
  })
  .strict();
type ToolResultEvent = Extract<StreamEvent, { type: "TOOL_CALL_RESULT" }>;
const toolResultSchema: z.ZodType<ToolResultEvent> = z
  .object({
    type: z.literal("TOOL_CALL_RESULT"),
    messageId: idSchema,
    toolCallId: idSchema,
    toolCallName: idSchema.optional(),
    content: textSchema,
    role: z.literal("tool").optional(),
    isError: z.boolean().optional(),
    error: validationErrorSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    type: "TOOL_CALL_RESULT" as const,
    messageId: value.messageId,
    toolCallId: value.toolCallId,
    ...(value.toolCallName !== undefined ? { toolCallName: value.toolCallName } : {}),
    content: value.content,
    ...(value.role !== undefined ? { role: value.role } : {}),
    ...(value.isError !== undefined ? { isError: value.isError } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  }));

type ActivityEvent = Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>;
const activitySchema: z.ZodType<ActivityEvent> = z
  .object({
    type: z.literal("ACTIVITY_SNAPSHOT"),
    messageId: z
      .string()
      .regex(/^sweatpants:plugin-replay:/)
      .max(MAX_ID_LENGTH),
    activityType: z.literal("sweatpants:plugin-replay"),
    replace: z.literal(true),
    content: z
      .object({
        version: z.literal(1),
        toolCallId: idSchema,
        toolName: idSchema,
        trace: replayTraceSchema,
      })
      .strict(),
  })
  .strict()
  .transform(
    (value): ActivityEvent => ({
      type: "ACTIVITY_SNAPSHOT",
      messageId: value.messageId as ActivityEvent["messageId"],
      activityType: "sweatpants:plugin-replay",
      replace: true,
      content: value.content,
    }),
  );
const reasoningSchema: z.ZodType<Extract<StreamEvent, { type: "REASONING_MESSAGE_CONTENT" }>> = z
  .object({
    type: z.literal("REASONING_MESSAGE_CONTENT"),
    messageId: idSchema,
    delta: textSchema,
  })
  .strict();

const streamEventSchema: z.ZodType<StreamEvent> = z.union([
  runStartedSchema,
  runFinishedSchema,
  runErrorSchema,
  messagesSnapshotSchema,
  stateSnapshotSchema,
  textStartSchema,
  textContentSchema,
  textEndSchema,
  toolCallStartSchema,
  toolCallArgsSchema,
  toolCallEndSchema,
  toolResultSchema,
  activitySchema,
  reasoningSchema,
]);

const storedConversationCheckpointSchema = z
  .object({
    version: z.literal(1),
    events: z.array(streamEventSchema).max(MAX_CHECKPOINT_EVENTS),
  })
  .strict();

export class ConversationCheckpointError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationCheckpointError";
  }
}

function assertCheckpointSize(encoded: string): void {
  if (new TextEncoder().encode(encoded).byteLength > MAX_CHECKPOINT_BYTES) {
    throw new ConversationCheckpointError("Conversation checkpoint exceeds the size limit");
  }
}

export function encodeConversationCheckpoint(events: readonly StreamEvent[]): string {
  try {
    const artifact = storedConversationCheckpointSchema.parse({ version: 1, events });
    const encoded = JSON.stringify(artifact);
    assertCheckpointSize(encoded);
    return encoded;
  } catch (error) {
    if (error instanceof ConversationCheckpointError) throw error;
    throw new ConversationCheckpointError("Conversation checkpoint cannot be encoded", {
      cause: error,
    });
  }
}

export function decodeConversationCheckpoint(raw: string): StreamEvent[] {
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_CHECKPOINT_BYTES) {
      throw new ConversationCheckpointError("Conversation checkpoint exceeds the size limit");
    }
    const value: unknown = JSON.parse(raw);
    return storedConversationCheckpointSchema.parse(value).events;
  } catch (error) {
    if (error instanceof ConversationCheckpointError) throw error;
    throw new ConversationCheckpointError("Conversation checkpoint is malformed", {
      cause: error,
    });
  }
}
