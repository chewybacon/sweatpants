import {
  failure,
  parser,
  success,
  type Json,
  type JsonObject,
  type ParseIssue,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import { z } from "zod";
import { decodeChatContent, type ChatContent, type ChatContentPart } from "./content.ts";

export type ChatMessage =
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatSystemMessage
  | ChatDeveloperMessage
  | ChatToolResultMessage;

export interface ChatUserMessage {
  readonly role: "user";
  readonly content: ChatContent;
}

export interface ChatAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ChatMessagePart[];
}

export interface ChatSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface ChatDeveloperMessage {
  readonly role: "developer";
  readonly content: string;
}

export interface ChatToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: ChatContent;
  readonly isError: boolean;
}

export type ChatMessagePart = ChatContentPart | ChatReasoningPart | ChatToolCallPart;

export interface ChatReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly format: string | null;
  readonly signature: string | null;
  readonly redacted: boolean;
}

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Json;
  readonly thoughtSignature: string | null;
}

export interface ChatToolCallPart {
  readonly type: "tool-call";
  readonly toolCall: ChatToolCall;
}

export type ChatToolDefinition = {
  readonly name: string;
  readonly description: string | null;
  readonly parameters: JsonObject;
};

export type ChatMessageDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "invalid-role"
  | "invalid-part"
  | "invalid-tool-call"
  | "invalid-tool-definition";

export class ChatMessageDecodeError extends TypeError {
  readonly code: ChatMessageDecodeErrorCode;
  readonly path: string;

  constructor(code: ChatMessageDecodeErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ChatMessageDecodeError";
    this.code = code;
    this.path = path;
  }
}

const nonemptyString = z.string().min(1);
const nullableString = z.string().nullable().optional();

const chatToolCallSchema = z.strictObject({
  id: nonemptyString,
  name: nonemptyString,
  input: z.json(),
  thoughtSignature: nullableString,
});

const chatToolDefinitionSchema = z.strictObject({
  name: nonemptyString,
  description: nullableString,
  parameters: z.record(z.string(), z.json()),
});

const assistantPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("reasoning"),
    text: z.string(),
    format: nullableString,
    signature: nullableString,
    redacted: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("tool-call"), toolCall: chatToolCallSchema }),
]);

const chatMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), content: z.unknown() }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.array(assistantPartSchema),
  }),
  z.strictObject({ role: z.literal("system"), content: z.string() }),
  z.strictObject({ role: z.literal("developer"), content: z.string() }),
  z.strictObject({
    role: z.literal("tool"),
    toolCallId: nonemptyString,
    name: nonemptyString,
    content: z.unknown(),
    isError: z.boolean(),
  }),
]);

const chatMessagesSchema = z.array(chatMessageSchema);

type StructuralChatToolCall = z.infer<typeof chatToolCallSchema>;
type StructuralChatToolDefinition = z.infer<typeof chatToolDefinitionSchema>;
type StructuralAssistantPart = z.infer<typeof assistantPartSchema>;
type StructuralChatMessage = z.infer<typeof chatMessageSchema>;

const chatMessageStructureParser = parser(chatMessageSchema);
const chatMessagesStructureParser = parser(chatMessagesSchema);
const chatToolCallStructureParser = parser(chatToolCallSchema);
const chatToolDefinitionStructureParser = parser(chatToolDefinitionSchema);

/** Result-oriented parser for one canonical Chat message. */
export const chatMessageParser: Parser<ChatMessage> = chatMessageStructureParser.andThen((value) =>
  normalizeMessageResult(value, "$"),
);

/** Result-oriented parser for canonical Chat message arrays. */
export const chatMessagesParser: Parser<readonly ChatMessage[]> =
  chatMessagesStructureParser.andThen((values) => {
    const output: ChatMessage[] = [];
    for (const [index, value] of values.entries()) {
      const parsed = normalizeMessageResult(value, `$.${index}`);
      if (!parsed.ok) {
        return parsed;
      }
      output.push(parsed.value);
    }
    return success(freeze(output) as readonly ChatMessage[]);
  });

/** Result-oriented parser for one canonical tool call. */
export const chatToolCallParser: Parser<ChatToolCall> = chatToolCallStructureParser.andThen(
  (value) => success(normalizeToolCall(value)),
);

/** Result-oriented parser for one canonical tool definition. */
export const chatToolDefinitionParser: Parser<ChatToolDefinition> =
  chatToolDefinitionStructureParser.andThen((value) => success(normalizeToolDefinition(value)));

export function decodeChatMessage(value: unknown, path = "$"): ChatMessage {
  const parsed = chatMessageStructureParser.parse(value);
  if (!parsed.ok) {
    throw messageErrorFromIssues(parsed.issues, path, "message");
  }
  return requireMessage(normalizeMessageResult(parsed.value, path));
}

export function decodeChatAssistantMessage(value: unknown, path = "$"): ChatAssistantMessage {
  const message = decodeChatMessage(value, path);
  if (message.role !== "assistant") {
    throw new ChatMessageDecodeError(
      "invalid-role",
      `${path}.role`,
      "expected an assistant message",
    );
  }
  return message;
}

export function decodeChatMessages(value: unknown, path = "$"): readonly ChatMessage[] {
  const parsed = chatMessagesStructureParser.parse(value);
  if (!parsed.ok) {
    throw messageErrorFromIssues(parsed.issues, path, "messages");
  }
  const output: ChatMessage[] = [];
  for (const [index, entry] of parsed.value.entries()) {
    output.push(requireMessage(normalizeMessageResult(entry, `${path}[${index}]`)));
  }
  return freeze(output) as readonly ChatMessage[];
}

export function decodeChatToolCall(value: unknown, path = "$"): ChatToolCall {
  const parsed = chatToolCallStructureParser.parse(value);
  if (!parsed.ok) {
    const error = messageErrorFromIssues(parsed.issues, path, "tool-call");
    if (
      error.code === "missing-field" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "input")
    ) {
      throw new ChatMessageDecodeError("invalid-value", error.path, error.message);
    }
    throw error;
  }
  return normalizeToolCall(parsed.value);
}

export function decodeChatToolDefinition(value: unknown, path = "$"): ChatToolDefinition {
  const parsed = chatToolDefinitionStructureParser.parse(value);
  if (!parsed.ok) {
    throw messageErrorFromIssues(parsed.issues, path, "tool-definition");
  }
  return normalizeToolDefinition(parsed.value);
}

function normalizeMessageResult(
  value: StructuralChatMessage,
  path: string,
): ParseResult<ChatMessage> {
  try {
    return success(normalizeMessage(value, path));
  } catch (error) {
    if (error instanceof ChatMessageDecodeError) {
      return failure(issueFromMessageError(error));
    }
    throw error;
  }
}

function normalizeMessage(value: StructuralChatMessage, path: string): ChatMessage {
  switch (value.role) {
    case "user":
      return freeze({ role: "user", content: decodeContent(value.content, `${path}.content`) });
    case "assistant":
      return freeze({
        role: "assistant",
        content: freeze(
          value.content.map((part, index) =>
            normalizeAssistantPart(part, `${path}.content.${index}`),
          ),
        ),
      });
    case "system":
      return freeze({ role: "system", content: value.content });
    case "developer":
      return freeze({ role: "developer", content: value.content });
    case "tool":
      return freeze({
        role: "tool",
        toolCallId: value.toolCallId,
        name: value.name,
        content: decodeContent(value.content, `${path}.content`),
        isError: value.isError,
      });
  }
}

function normalizeAssistantPart(value: StructuralAssistantPart, path: string): ChatMessagePart {
  switch (value.type) {
    case "text":
      return freeze({ type: "text", text: value.text });
    case "reasoning":
      return freeze({
        type: "reasoning",
        text: value.text,
        format: value.format ?? null,
        signature: value.signature ?? null,
        redacted: value.redacted ?? false,
      });
    case "tool-call":
      try {
        return freeze({ type: "tool-call", toolCall: normalizeToolCall(value.toolCall) });
      } catch (error) {
        if (error instanceof ChatMessageDecodeError) {
          throw error;
        }
        throw new ChatMessageDecodeError(
          "invalid-tool-call",
          `${path}.toolCall`,
          error instanceof Error ? error.message : "invalid settled tool call",
        );
      }
  }
}

function normalizeToolCall(value: StructuralChatToolCall): ChatToolCall {
  return freeze({
    id: value.id,
    name: value.name,
    input: value.input as Json,
    thoughtSignature: value.thoughtSignature ?? null,
  });
}

function normalizeToolDefinition(value: StructuralChatToolDefinition): ChatToolDefinition {
  return freeze({
    name: value.name,
    description: value.description ?? null,
    parameters: value.parameters as JsonObject,
  });
}

function decodeContent(value: unknown, path: string): ChatContent {
  try {
    return decodeChatContent(value);
  } catch (error) {
    throw new ChatMessageDecodeError(
      "invalid-part",
      path,
      error instanceof Error ? error.message : "content did not decode",
    );
  }
}

function requireMessage(result: ParseResult<ChatMessage>): ChatMessage {
  if (result.ok) {
    return result.value;
  }
  throw messageErrorFromIssues(result.issues, "$", "message");
}

function messageErrorFromIssues(
  issues: readonly ParseIssue[],
  basePath: string,
  context: "message" | "messages" | "tool-call" | "tool-definition",
): ChatMessageDecodeError {
  const issue = issues[0] ?? { path: [], message: "invalid value" };
  const relative = issue.path.map(String).join(".");
  const path = relative.length === 0 ? basePath : `${basePath}.${relative}`;
  let code: ChatMessageDecodeErrorCode = "invalid-value";
  if (issue.code === "unrecognized_keys") {
    code = "unknown-field";
  } else if (context === "tool-call") {
    code =
      issue.path.at(-1) === "input" &&
      (issue.code === "invalid_type" || issue.code === "invalid_union")
        ? "missing-field"
        : "invalid-value";
  } else if (context === "tool-definition") {
    code = issue.code === "unrecognized_keys" ? "unknown-field" : "invalid-tool-definition";
  } else if (
    issue.path.includes("role") ||
    (issue.code === "invalid_union" && issue.path.length === 0)
  ) {
    code = "invalid-role";
  } else if (issue.path.includes("toolCall")) {
    code = "invalid-tool-call";
  } else if (issue.path.includes("content")) {
    code = "invalid-part";
  } else if (context === "messages") {
    code = "invalid-value";
  }
  return new ChatMessageDecodeError(code, path, issue.message);
}

function issueFromMessageError(error: ChatMessageDecodeError): ParseIssue {
  return {
    path: decodePath(error.path),
    message: error.message,
    code: error.code,
  };
}

function decodePath(path: string): Array<string | number> {
  if (path === "$" || path.length === 0) {
    return [];
  }
  return path
    .replace(/^\$\.?/u, "")
    .split(/[.[\]]+/u)
    .filter(Boolean)
    .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}
