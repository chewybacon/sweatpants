import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  JsonPatchOperation,
  PublicActivityData,
  PublicActivityNode,
  StructuredOutputCompleteEvent,
  StructuredOutputStartEvent,
  SweatpantsPublicActivity,
} from "./chat-client-types.ts";

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

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected an object", path);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid("expected a non-empty string", path);
  }
  return value;
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
const kinds = new Set<PublicActivityNode["kind"]>(["tool-call", "message", "activity", "elicit"]);

function isActivityKind(value: unknown): value is PublicActivityNode["kind"] {
  return typeof value === "string" && kinds.has(value as PublicActivityNode["kind"]);
}

function isActivityState(value: unknown): value is PublicActivityNode["state"] {
  return typeof value === "string" && states.has(value);
}

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

function assertKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      activityInvalid(`unknown field ${key}`, `${path}.${key}`);
    }
  }
}

function assertEventKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      invalid(`unknown field ${key}`, `${path}.${key}`);
    }
  }
}

function decodeStructuredOutputStart(
  base: AGUIEvent,
  input: Record<string, unknown>,
): StructuredOutputStartEvent {
  const value = record(input["value"], "$.value");
  assertEventKeys(value, ["messageId"], "$.value");
  const messageId = string(value["messageId"], "$.value.messageId");
  return {
    ...(base as StructuredOutputStartEvent),
    name: "structured-output.start",
    value: { messageId },
  };
}

function decodeStructuredOutputComplete(
  base: AGUIEvent,
  input: Record<string, unknown>,
): StructuredOutputCompleteEvent {
  const value = record(input["value"], "$.value");
  assertEventKeys(value, ["messageId", "object", "raw", "reasoning"], "$.value");
  const messageId =
    value["messageId"] === undefined ? undefined : string(value["messageId"], "$.value.messageId");
  const raw = string(value["raw"], "$.value.raw");
  const reasoning = value["reasoning"];
  if (reasoning !== undefined && typeof reasoning !== "string") {
    invalid("expected a string", "$.value.reasoning");
  }
  return {
    ...(base as StructuredOutputCompleteEvent),
    name: "structured-output.complete",
    value: {
      ...(messageId !== undefined ? { messageId } : {}),
      object: json(value["object"], "$.value.object"),
      raw,
      ...(reasoning !== undefined ? { reasoning } : {}),
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
  const input = record(value, path);
  if (input["kind"] !== kind) {
    activityInvalid("publicData.kind must equal node.kind", `${path}.kind`);
  }
  if (kind === "message") {
    assertKeys(input, ["kind", "messageId", "role"], path);
    const role = input["role"];
    if (role !== "user" && role !== "assistant" && role !== "system") {
      activityInvalid("invalid message role", `${path}.role`);
    }
    return { kind, messageId: string(input["messageId"], `${path}.messageId`), role };
  }
  if (kind === "tool-call") {
    assertKeys(input, ["kind", "callId", "name", "rawInput", "input", "output", "errorText"], path);
    const output: {
      kind: "tool-call";
      callId: string;
      name: string;
      rawInput?: string;
      input?: Json;
      output?: Json;
      errorText?: string;
    } = {
      kind,
      callId: string(input["callId"], `${path}.callId`),
      name: string(input["name"], `${path}.name`),
    };
    for (const key of ["rawInput", "errorText"] as const) {
      const valueAtKey = input[key];
      if (valueAtKey !== undefined) {
        if (typeof valueAtKey !== "string") {
          activityInvalid(`expected string ${key}`, `${path}.${key}`);
        }
        output[key] = valueAtKey;
      }
    }
    for (const key of ["input", "output"] as const) {
      const valueAtKey = input[key];
      if (valueAtKey !== undefined) {
        output[key] = json(valueAtKey, `${path}.${key}`);
      }
    }
    return output;
  }
  if (kind === "activity") {
    assertKeys(input, ["kind", "activityType", "data"], path);
    const activityType = string(input["activityType"], `${path}.activityType`);
    return {
      kind,
      activityType,
      ...(input["data"] !== undefined ? { data: json(input["data"], `${path}.data`) } : {}),
    };
  }
  assertKeys(
    input,
    [
      "kind",
      "elicitId",
      "bindingId",
      "key",
      "message",
      "context",
      "responseContract",
      "contextContract",
      "toolName",
      "callId",
      "producerSequence",
    ],
    path,
  );
  const responseContract = parseDescriptor(input["responseContract"], `${path}.responseContract`);
  const contextContract =
    input["contextContract"] === undefined
      ? undefined
      : parseDescriptor(input["contextContract"], `${path}.contextContract`);
  const producerSequence = input["producerSequence"];
  if (
    typeof producerSequence !== "number" ||
    !Number.isSafeInteger(producerSequence) ||
    producerSequence < 0
  ) {
    activityInvalid(
      "producerSequence must be a nonnegative safe integer",
      `${path}.producerSequence`,
    );
  }
  return {
    kind,
    elicitId: string(input["elicitId"], `${path}.elicitId`),
    bindingId: string(input["bindingId"], `${path}.bindingId`),
    key: string(input["key"], `${path}.key`),
    message: string(input["message"], `${path}.message`),
    ...(input["context"] !== undefined
      ? { context: json(input["context"], `${path}.context`) }
      : {}),
    responseContract,
    ...(contextContract !== undefined ? { contextContract } : {}),
    toolName: string(input["toolName"], `${path}.toolName`),
    callId: string(input["callId"], `${path}.callId`),
    producerSequence,
  };
}

export function decodePublicActivity(value: unknown, path = "$.content"): SweatpantsPublicActivity {
  const input = record(value, path);
  assertKeys(input, ["version", "node"], path);
  if (input["version"] !== 1) {
    activityInvalid("content.version must be 1", `${path}.version`);
  }
  const nodeInput = record(input["node"], `${path}.node`);
  assertKeys(
    nodeInput,
    ["nodeId", "parentNodeId", "sequence", "kind", "state", "presentation", "publicData"],
    `${path}.node`,
  );
  const kindValue = nodeInput["kind"];
  if (!isActivityKind(kindValue)) {
    activityInvalid("invalid node.kind", `${path}.node.kind`);
  }
  const kind = kindValue;
  const stateValue = nodeInput["state"];
  if (!isActivityState(stateValue)) {
    activityInvalid("invalid node.state", `${path}.node.state`);
  }
  const state = stateValue;
  assertKindState(kind, state, `${path}.node.state`);
  const sequenceValue = nodeInput["sequence"];
  if (
    typeof sequenceValue !== "number" ||
    !Number.isSafeInteger(sequenceValue) ||
    sequenceValue < 0
  ) {
    activityInvalid("node.sequence must be a nonnegative safe integer", `${path}.node.sequence`);
  }
  const sequence = sequenceValue;
  const parentValue = nodeInput["parentNodeId"];
  if (parentValue !== null && typeof parentValue !== "string") {
    activityInvalid("parentNodeId must be string or null", `${path}.node.parentNodeId`);
  }
  const parentNodeId: string | null = parentValue;
  const presentation = nodeInput["presentation"];
  if (presentation !== "public" && presentation !== "opaque") {
    activityInvalid("invalid presentation", `${path}.node.presentation`);
  }
  const data = publicData(nodeInput["publicData"], `${path}.node.publicData`, kind);
  if (kind === "message" && data === undefined) {
    activityInvalid("message activity requires publicData", `${path}.node.publicData`);
  }
  if (kind === "tool-call" && data === undefined) {
    activityInvalid("tool-call activity requires publicData", `${path}.node.publicData`);
  }
  if (kind === "elicit" && data === undefined) {
    activityInvalid("elicit activity requires publicData", `${path}.node.publicData`);
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
    nodeId: string(nodeInput["nodeId"], `${path}.node.nodeId`),
    parentNodeId,
    sequence,
    kind,
    state,
    presentation,
    ...(data !== undefined ? { publicData: data } : {}),
  } as PublicActivityNode;
  return { version: 1, node };
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

export function validateActivityPatch(patchValue: unknown, path = "$.patch"): JsonPatchOperation[] {
  if (!Array.isArray(patchValue)) {
    patchInvalid("patch must be an array", path);
  }
  return patchValue.map((entry, index) => {
    const input = record(entry, `${path}[${index}]`);
    const opValue = input["op"];
    if (opValue !== "add" && opValue !== "remove" && opValue !== "replace") {
      patchInvalid("invalid RFC 6902 operation", `${path}[${index}].op`);
    }
    const op = opValue;
    const patchPath = string(input["path"], `${path}[${index}].path`);
    if (!patchPathAllowed(patchPath)) {
      patchInvalid("patch path is immutable or disallowed", `${path}[${index}].path`);
    }
    if (input["from"] !== undefined) {
      patchInvalid(
        "from is not valid for an allowed activity patch operation",
        `${path}[${index}].from`,
      );
    }
    if (op === "remove" && input["value"] !== undefined) {
      patchInvalid("remove patches must not carry a value", `${path}[${index}].value`);
    }
    if ((op === "add" || op === "replace") && input["value"] === undefined) {
      patchInvalid("add and replace patches require a value", `${path}[${index}].value`);
    }
    const patchJsonValue =
      input["value"] === undefined ? undefined : json(input["value"], `${path}[${index}].value`);
    if (
      patchPath === "/node/state" &&
      (op === "remove" ||
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
    return {
      op,
      path: patchPath,
      ...(patchJsonValue !== undefined ? { value: patchJsonValue } : {}),
    };
  });
}

function decodeActivitySnapshot(input: Record<string, unknown>): ActivitySnapshotEvent {
  const messageId = string(input["messageId"], "$.messageId");
  const activityType = string(input["activityType"], "$.activityType");
  const content = json(input["content"], "$.content");
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    activityInvalid("content must be an object", "$.content");
  }
  if (activityType === "sweatpants:public-execution") {
    decodePublicActivity(content);
  }
  const contentObject = content;
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
    messageId: string(input["messageId"], "$.messageId"),
    activityType: string(input["activityType"], "$.activityType"),
    patch: validateActivityPatch(input["patch"]),
  };
}

/** Parse and validate one serialized AG-UI event at a transport/checkpoint boundary. */
export function decodeAGUIEvent(value: unknown): AGUIEvent {
  const envelope = record(value, "$");
  const input =
    envelope["type"] === undefined &&
    envelope["event"] !== undefined &&
    typeof envelope["event"] === "object"
      ? record(envelope["event"], "$.event")
      : envelope;
  const type = input["type"];
  if (
    type === "HOST_TREE_DELTA" ||
    type === "HOST_TREE_SNAPSHOT" ||
    type === "sweatpants:plugin-replay" ||
    (typeof type === "string" && deprecatedEventTypes.has(type))
  ) {
    invalid(`removed or deprecated event ${String(type)}`);
  }
  const parsed = EventSchemas.safeParse(input);
  if (!parsed.success) {
    invalid(`invalid AG-UI event: ${parsed.error.message}`);
  }
  if (type === EventType.ACTIVITY_SNAPSHOT) {
    return decodeActivitySnapshot(input);
  }
  if (type === EventType.ACTIVITY_DELTA) {
    return decodeActivityDelta(input);
  }
  if (type === EventType.CUSTOM) {
    if (parsed.data.name === "structured-output.start") {
      return decodeStructuredOutputStart(parsed.data, input);
    }
    if (parsed.data.name === "structured-output.complete") {
      return decodeStructuredOutputComplete(parsed.data, input);
    }
  }
  return parsed.data;
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
  const input = record(value, "$");
  if (input["type"] !== EventType.ACTIVITY_SNAPSHOT) {
    invalid("expected ACTIVITY_SNAPSHOT");
  }
  return decodeActivitySnapshot(input);
}

export function decodeActivityDeltaEvent(value: unknown): ActivityDeltaEvent {
  const input = record(value, "$");
  if (input["type"] !== EventType.ACTIVITY_DELTA) {
    invalid("expected ACTIVITY_DELTA");
  }
  return decodeActivityDelta(input);
}
