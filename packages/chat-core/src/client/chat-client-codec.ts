import { EventSchemas } from "@ag-ui/core/schemas";
import {
  EventType,
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type AGUIEvent,
} from "@ag-ui/core";
import {
  assertJson,
  canonicalJson,
  failure,
  parser,
  success,
  type Json,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { z } from "zod";
import type {
  JsonPatchOperation,
  StructuredOutputCompleteEvent,
  StructuredOutputStartEvent,
} from "./chat-protocol-types.ts";
import type {
  PublicActivityData,
  PublicActivityNode,
  SweatpantsPublicActivity,
} from "./public-activity.ts";

export type ChatProtocolErrorCode =
  | "chat_event_invalid"
  | "chat_activity_invalid"
  | "chat_activity_patch_invalid";

export class ChatProtocolError extends Error {
  constructor(
    readonly code: ChatProtocolErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ChatProtocolError";
  }
}

function invalid(message: string, path?: string): never {
  throw new ChatProtocolError("chat_event_invalid", message, path);
}

function activityInvalid(message: string, path?: string): never {
  throw new ChatProtocolError("chat_activity_invalid", message, path);
}

function patchInvalid(message: string, path?: string): never {
  throw new ChatProtocolError("chat_activity_patch_invalid", message, path);
}

function json(value: unknown, path: string): Json {
  try {
    return assertJson(value, path);
  } catch (error) {
    invalid(error instanceof Error ? error.message : "invalid JSON", path);
  }
}

const deprecatedEventTypes = new Set([
  "THINKING_START",
  "THINKING_END",
  "THINKING_TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_END",
]);

const statesByKind: Readonly<Record<PublicActivityNode["kind"], ReadonlySet<string>>> = {
  message: new Set(["streaming", "done"]),
  "tool-call": new Set(["input-streaming", "input-available", "output-available", "output-error"]),
  activity: new Set(["running", "complete", "error", "cancelled"]),
  elicit: new Set(["pending", "responded", "cancelled"]),
};
const states = new Set(Object.values(statesByKind).flatMap((values) => [...values]));
const jsonValueSchema = z.unknown().transform((value, context) => {
  try {
    return assertJson(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid JSON value" });
    return z.NEVER;
  }
});
const publicMessageDataSchema = z.strictObject({
  kind: z.literal("message"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
});
const publicToolCallDataSchema = z.strictObject({
  kind: z.literal("tool-call"),
  callId: z.string().min(1),
  name: z.string().min(1),
  rawInput: z.string().optional(),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  errorText: z.string().optional(),
});
const publicActivityDataSchema = z.strictObject({
  kind: z.literal("activity"),
  activityType: z.string().min(1),
  data: jsonValueSchema.optional(),
});
const publicElicitDataSchema = z.strictObject({
  kind: z.literal("elicit"),
  elicitId: z.string().min(1),
  bindingId: z.string().min(1),
  key: z.string().min(1),
  message: z.string().min(1),
  context: jsonValueSchema.optional(),
  responseContract: z.unknown(),
  contextContract: z.unknown().optional(),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  producerSequence: z.number().int().nonnegative(),
});
const publicActivitySchema = z.strictObject({
  version: z.literal(1),
  node: z.strictObject({
    nodeId: z.string().min(1),
    parentNodeId: z.string().nullable(),
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["tool-call", "message", "activity", "elicit"]),
    state: z.enum([
      "streaming",
      "done",
      "input-streaming",
      "input-available",
      "output-available",
      "output-error",
      "running",
      "complete",
      "error",
      "cancelled",
      "pending",
      "responded",
    ]),
    presentation: z.enum(["public", "opaque"]),
    publicData: z.record(z.string(), z.unknown()).optional(),
  }),
});
const activityPatchSchema = z.array(
  z.strictObject({
    op: z.enum(["add", "remove", "replace"]),
    path: z.string(),
    from: z.unknown().optional(),
    value: jsonValueSchema.optional(),
  }),
);
const structuredOutputStartValueSchema = z.strictObject({ messageId: z.string().min(1) });
const structuredOutputCompleteValueSchema = z.strictObject({
  messageId: z.string().min(1).optional(),
  object: jsonValueSchema,
  raw: z.string().min(1),
  reasoning: z.string().optional(),
});
const aguiEnvelopeSchema = z.record(z.string(), z.unknown());
const aguiEnvelopeParser = parser(aguiEnvelopeSchema);
const activityContentParser = parser(z.record(z.string(), z.unknown()));
const aguiEventStructureParser = parser(EventSchemas);
const publicDataParsers = {
  message: parser(publicMessageDataSchema),
  "tool-call": parser(publicToolCallDataSchema),
  activity: parser(publicActivityDataSchema),
  elicit: parser(publicElicitDataSchema),
} as const;
const publicActivityStructureParser = parser(publicActivitySchema);
const activityPatchStructureParser = parser(activityPatchSchema);
const structuredOutputStartValueParser = parser(structuredOutputStartValueSchema);
const structuredOutputCompleteValueParser = parser(structuredOutputCompleteValueSchema);

function assertKindState(
  kind: PublicActivityNode["kind"],
  state: PublicActivityNode["state"],
  path: string,
): void {
  if (!statesByKind[kind].has(state)) {
    activityInvalid(`state ${state} is not valid for node kind ${kind}`, path);
  }
}

function assertToolLifecycle(
  state: PublicActivityNode["state"],
  data: PublicActivityData,
  path: string,
): void {
  if (data.kind !== "tool-call") {
    return;
  }
  if (state === "input-streaming") {
    if (data.output !== undefined || data.errorText !== undefined) {
      activityInvalid("input-streaming tool activity cannot contain output", path);
    }
    return;
  }
  if (state === "input-available") {
    if (data.input === undefined || data.output !== undefined || data.errorText !== undefined) {
      activityInvalid("input-available tool activity requires only settled input", path);
    }
    return;
  }
  if (state === "output-available") {
    if (data.input === undefined || data.output === undefined || data.errorText !== undefined) {
      activityInvalid("output-available tool activity requires input and output", path);
    }
    return;
  }
  if (state === "output-error" && (data.errorText === undefined || data.output !== undefined)) {
    activityInvalid("output-error tool activity requires errorText and no output", path);
  }
}

function decodeStructuredOutputStart(
  base: AGUIEvent,
  input: Record<string, unknown>,
): StructuredOutputStartEvent {
  const parsed = structuredOutputStartValueParser.parse(input["value"]);
  if (!parsed.ok) {
    invalid("invalid structured-output.start value", "$.value");
  }
  return {
    ...(base as StructuredOutputStartEvent),
    name: "structured-output.start",
    value: { messageId: parsed.value.messageId },
  };
}

function decodeStructuredOutputComplete(
  base: AGUIEvent,
  input: Record<string, unknown>,
): StructuredOutputCompleteEvent {
  const parsed = structuredOutputCompleteValueParser.parse(input["value"]);
  if (!parsed.ok) {
    invalid("invalid structured-output.complete value", "$.value");
  }
  const value = parsed.value;
  return {
    ...(base as StructuredOutputCompleteEvent),
    name: "structured-output.complete",
    value: {
      /* CONDITIONAL-SPREAD: Omit absent messageId from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(value.messageId !== undefined ? { messageId: value.messageId } : {}),
      object: json(value.object, "$.value.object"),
      raw: value.raw,
      /* CONDITIONAL-SPREAD: Omit absent reasoning from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
    },
  };
}

function parseDescriptor(value: unknown, path: string): PortableSchemaDescriptor {
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    activityInvalid("expected a valid portable schema descriptor", path);
  }
}

function publicData(
  value: unknown,
  path: string,
  kind: PublicActivityNode["kind"],
): PublicActivityData | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = publicDataParsers[kind].parse(value);
  if (!parsed.ok) {
    activityInvalid(parsed.issues[0]?.message ?? "invalid public activity data", path);
  }
  const input = parsed.value as Record<string, unknown>;
  if (kind === "message") {
    return {
      kind,
      messageId: input["messageId"] as string,
      role: input["role"] as "user" | "assistant" | "system",
    };
  }
  if (kind === "tool-call") {
    return {
      kind,
      callId: input["callId"] as string,
      name: input["name"] as string,
      /* CONDITIONAL-SPREAD: Omit absent rawInput from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(input["rawInput"] !== undefined ? { rawInput: input["rawInput"] as string } : {}),
      /* CONDITIONAL-SPREAD: Omit absent input from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(input["input"] !== undefined ? { input: input["input"] as Json } : {}),
      /* CONDITIONAL-SPREAD: Omit absent output from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(input["output"] !== undefined ? { output: input["output"] as Json } : {}),
      /* CONDITIONAL-SPREAD: Omit absent errorText from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(input["errorText"] !== undefined ? { errorText: input["errorText"] as string } : {}),
    };
  }
  if (kind === "activity") {
    return {
      kind,
      activityType: input["activityType"] as string,
      /* CONDITIONAL-SPREAD: Omit absent data from portable chat history and projection records; explicit undefined is not a portable JSON value. */
      ...(input["data"] !== undefined ? { data: input["data"] as Json } : {}),
    };
  }
  const responseContract = parseDescriptor(input["responseContract"], `${path}.responseContract`);
  const contextContract =
    input["contextContract"] === undefined
      ? undefined
      : parseDescriptor(input["contextContract"], `${path}.contextContract`);
  return {
    kind,
    elicitId: input["elicitId"] as string,
    bindingId: input["bindingId"] as string,
    key: input["key"] as string,
    message: input["message"] as string,
    /* CONDITIONAL-SPREAD: Omit absent context from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["context"] !== undefined ? { context: input["context"] as Json } : {}),
    responseContract,
    /* CONDITIONAL-SPREAD: Omit absent contextContract from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(contextContract !== undefined ? { contextContract } : {}),
    toolName: input["toolName"] as string,
    callId: input["callId"] as string,
    producerSequence: input["producerSequence"] as number,
  };
}

export const publicActivityParser: Parser<SweatpantsPublicActivity> =
  publicActivityStructureParser.andThen((value) => {
    try {
      return success(normalizePublicActivity(value, "$.content"));
    } catch (error) {
      if (error instanceof ChatProtocolError) {
        return failure({ path: [], message: chatProtocolMessage(error), code: error.code });
      }
      throw error;
    }
  });

const decodedPublicActivities = new WeakSet<object>();

function retainPublicActivity(value: SweatpantsPublicActivity): SweatpantsPublicActivity {
  const pending: object[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (Object.isFrozen(current)) {
      continue;
    }
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  decodedPublicActivities.add(value);
  return value;
}

export function decodePublicActivity(value: unknown, path = "$.content"): SweatpantsPublicActivity {
  if (value !== null && typeof value === "object" && decodedPublicActivities.has(value)) {
    return value as SweatpantsPublicActivity;
  }
  const parsed = publicActivityParser.parse(value);
  if (!parsed.ok) {
    activityInvalid(parsed.issues[0]?.message ?? "invalid public activity", path);
  }
  return retainPublicActivity(parsed.value);
}

function normalizePublicActivity(value: unknown, path: string): SweatpantsPublicActivity {
  const input = value as Record<string, unknown>;
  const nodeInput = input["node"] as Record<string, unknown>;
  const kind = nodeInput["kind"] as PublicActivityNode["kind"];
  const state = nodeInput["state"] as PublicActivityNode["state"];
  assertKindState(kind, state, `${path}.node.state`);
  const presentation = nodeInput["presentation"] as "public" | "opaque";
  const data = publicData(nodeInput["publicData"], `${path}.node.publicData`, kind);
  if (kind !== "activity" && data === undefined) {
    activityInvalid(`${kind} activity requires publicData`, `${path}.node.publicData`);
  }
  if (data !== undefined) {
    assertToolLifecycle(state, data, `${path}.node.publicData`);
  }
  if (
    presentation === "opaque" &&
    data !== undefined &&
    !(
      data.kind === "activity" &&
      data.activityType === "opaque-execution" &&
      data.data === undefined
    )
  ) {
    activityInvalid("opaque activities may not carry public data", `${path}.node.publicData`);
  }
  const node = {
    nodeId: nodeInput["nodeId"] as string,
    parentNodeId: nodeInput["parentNodeId"] as string | null,
    sequence: nodeInput["sequence"] as number,
    kind,
    state,
    presentation,
    /* CONDITIONAL-SPREAD: Omit absent publicData from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(data !== undefined ? { publicData: data } : {}),
  } as PublicActivityNode;
  return { version: 1, node };
}

function chatProtocolMessage(error: ChatProtocolError): string {
  return error.message.slice(`[${error.code}] `.length);
}

function patchPathAllowed(path: string): boolean {
  return (
    path === "/node/state" ||
    path === "/node/publicData/rawInput" ||
    path === "/node/publicData/input" ||
    path === "/node/publicData/output" ||
    path === "/node/publicData/errorText" ||
    path === "/node/publicData/data"
  );
}

export const activityPatchParser: Parser<JsonPatchOperation[]> =
  activityPatchStructureParser.andThen((value) => {
    try {
      return success(normalizeActivityPatch(value, "$.patch"));
    } catch (error) {
      if (error instanceof ChatProtocolError) {
        return failure({ path: [], message: chatProtocolMessage(error), code: error.code });
      }
      throw error;
    }
  });

export function validateActivityPatch(patchValue: unknown, path = "$.patch"): JsonPatchOperation[] {
  const parsed = activityPatchParser.parse(patchValue);
  if (!parsed.ok) {
    patchInvalid(parsed.issues[0]?.message ?? "invalid activity patch", path);
  }
  return parsed.value;
}

function normalizeActivityPatch(
  value: readonly {
    readonly op: "add" | "remove" | "replace";
    readonly path: string;
    readonly from?: unknown;
    readonly value?: unknown;
  }[],
  path: string,
): JsonPatchOperation[] {
  return value.map((input, index) => {
    const patchPath = input.path;
    if (!patchPathAllowed(patchPath)) {
      patchInvalid("patch path is immutable or disallowed", `${path}[${index}].path`);
    }
    if (input.from !== undefined) {
      patchInvalid(
        "from is not valid for an allowed activity patch operation",
        `${path}[${index}].from`,
      );
    }
    if (input.op === "remove" && input.value !== undefined) {
      patchInvalid("remove patches must not carry a value", `${path}[${index}].value`);
    }
    if ((input.op === "add" || input.op === "replace") && input.value === undefined) {
      patchInvalid("add and replace patches require a value", `${path}[${index}].value`);
    }
    const patchJsonValue =
      input.value === undefined ? undefined : json(input.value, `${path}[${index}].value`);
    if (
      patchPath === "/node/state" &&
      (input.op === "remove" ||
        patchJsonValue === undefined ||
        typeof patchJsonValue !== "string" ||
        !states.has(patchJsonValue))
    ) {
      patchInvalid("invalid public activity state", `${path}[${index}].value`);
    }
    if (
      (patchPath === "/node/publicData/rawInput" || patchPath === "/node/publicData/errorText") &&
      patchJsonValue !== undefined &&
      typeof patchJsonValue !== "string"
    ) {
      patchInvalid("public activity text fields require strings", `${path}[${index}].value`);
    }
    if (input.op === "remove") {
      return { op: "remove", path: patchPath };
    }
    return { op: input.op, path: patchPath, value: patchJsonValue! };
  });
}

function decodeActivitySnapshot(input: Record<string, unknown>): ActivitySnapshotEvent {
  const messageId = input["messageId"] as string;
  const activityType = input["activityType"] as string;
  const rawContent = input["content"];
  let contentObject: Record<string, unknown>;
  if (activityType === "sweatpants:public-execution") {
    if (
      !(
        rawContent !== null &&
        typeof rawContent === "object" &&
        decodedPublicActivities.has(rawContent)
      )
    ) {
      // Validate the envelope without replacing already-owned descriptor identities.
      // The typed parser below owns the normalized result and each JSON data field.
      try {
        canonicalJson(rawContent);
      } catch (error) {
        invalid(error instanceof Error ? error.message : "invalid JSON", "$.content");
      }
    }
    contentObject = decodePublicActivity(rawContent) as unknown as Record<string, unknown>;
  } else {
    const contentResult = activityContentParser.parse(json(rawContent, "$.content"));
    if (!contentResult.ok) {
      activityInvalid("content must be an object", "$.content");
    }
    contentObject = contentResult.value;
  }
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType,
    content: contentObject,
    replace: input["replace"] !== false,
  };
}

function decodeActivityDelta(input: Record<string, unknown>): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: input["messageId"] as string,
    activityType: input["activityType"] as string,
    patch: validateActivityPatch(input["patch"]),
  };
}

/** Result-oriented parser for one serialized AG-UI event. */
export const aguiEventParser: Parser<AGUIEvent> =
  aguiEnvelopeParser.andThen(normalizeAGUIEventResult);

function normalizeAGUIEventResult(envelope: Record<string, unknown>): ParseResult<AGUIEvent> {
  const input =
    envelope["type"] === undefined && envelope["event"] !== undefined
      ? aguiEnvelopeParser.parse(envelope["event"])
      : success(envelope);
  if (!input.ok) {
    return input;
  }

  const type = input.value["type"];
  if (
    type === "HOST_TREE_DELTA" ||
    type === "HOST_TREE_SNAPSHOT" ||
    type === "sweatpants:plugin-replay" ||
    (typeof type === "string" && deprecatedEventTypes.has(type))
  ) {
    return failure({
      path: ["type"],
      message: `removed or deprecated event ${String(type)}`,
      code: "chat_event_invalid",
    });
  }
  const parsed = aguiEventStructureParser.parse(input.value);
  if (!parsed.ok) {
    return parsed;
  }

  try {
    if (type === EventType.ACTIVITY_SNAPSHOT) {
      return success({ ...parsed.value, ...decodeActivitySnapshot(input.value) });
    }
    if (type === EventType.ACTIVITY_DELTA) {
      return success({ ...parsed.value, ...decodeActivityDelta(input.value) });
    }
    if (type === EventType.CUSTOM) {
      const custom = parsed.value as AGUIEvent & { name?: string };
      if (custom.name === "structured-output.start") {
        return success(decodeStructuredOutputStart(parsed.value, input.value));
      }
      if (custom.name === "structured-output.complete") {
        return success(decodeStructuredOutputComplete(parsed.value, input.value));
      }
    }
    return success(parsed.value);
  } catch (error) {
    if (error instanceof ChatProtocolError) {
      return failure({ path: [], message: chatProtocolMessage(error), code: error.code });
    }
    throw error;
  }
}

/** Parse and validate one serialized AG-UI event at a transport/checkpoint boundary. */
export function decodeAGUIEvent(value: unknown): AGUIEvent {
  const parsed = aguiEventParser.parse(value);
  if (parsed.ok) {
    return parsed.value;
  }

  const issue = parsed.issues[0];
  const code =
    issue?.code === "chat_activity_invalid" ||
    issue?.code === "chat_activity_patch_invalid" ||
    issue?.code === "chat_event_invalid"
      ? issue.code
      : "chat_event_invalid";
  throw new ChatProtocolError(
    code,
    issue?.message ?? "invalid AG-UI event",
    issue && issue.path.length > 0 ? `$.${issue.path.join(".")}` : undefined,
  );
}

export function encodeAGUIEvent(event: AGUIEvent): string {
  try {
    return canonicalJson(decodeAGUIEvent(event));
  } catch (error) {
    throw new ChatProtocolError(
      "chat_event_invalid",
      error instanceof Error ? error.message : "event is not JSON",
    );
  }
}

export function decodeActivitySnapshotEvent(value: unknown): ActivitySnapshotEvent {
  const event = decodeAGUIEvent(value);
  if (event.type !== EventType.ACTIVITY_SNAPSHOT) {
    invalid("expected ACTIVITY_SNAPSHOT");
  }
  return event;
}

export function decodeActivityDeltaEvent(value: unknown): ActivityDeltaEvent {
  const event = decodeAGUIEvent(value);
  if (event.type !== EventType.ACTIVITY_DELTA) {
    invalid("expected ACTIVITY_DELTA");
  }
  return event;
}
