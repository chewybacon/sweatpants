import {
  failure,
  parser,
  success,
  type JsonObject,
  type ParseIssue,
  type Parser,
} from "@sweatpants/foundation";
import { chatMessageParser, type ChatMessage } from "@sweatpants/chat-contract";
import { z } from "zod";

export type ChatHistoryEntry = ChatHistoryMessageEntry | ChatHistoryActivityEntry;

export interface ChatHistoryMessageEntry {
  readonly type: "message";
  readonly id: string;
  readonly message: ChatMessage;
  readonly metadata: JsonObject;
}

export interface ChatHistoryActivityEntry {
  readonly type: "activity";
  readonly id: string;
  readonly activityType: string;
  readonly data: JsonObject;
  readonly metadata: JsonObject;
}

export type ChatHistoryDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "invalid-entry"
  | "invalid-message"
  | "invalid-field";

export class ChatHistoryDecodeError extends TypeError {
  readonly code: ChatHistoryDecodeErrorCode;
  readonly path: string;

  constructor(code: ChatHistoryDecodeErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ChatHistoryDecodeError";
    this.code = code;
    this.path = path;
  }
}

const jsonObjectSchema = z.record(z.string(), z.json());
const historyEntrySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("message"),
    id: z.string().min(1),
    message: z.json(),
    metadata: jsonObjectSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("activity"),
    id: z.string().min(1),
    activityType: z.string().min(1),
    data: jsonObjectSchema,
    metadata: jsonObjectSchema.optional(),
  }),
]);
const historyEntryStructureParser = parser(historyEntrySchema);
const historyEntriesStructureParser = parser(z.array(z.json()));

/** Result-oriented parser for one canonical Chat history entry. */
export const chatHistoryEntryParser: Parser<ChatHistoryEntry> = historyEntryStructureParser.andThen(
  (value) => {
    if (value.type === "message") {
      const message = chatMessageParser.parse(value.message);
      if (!message.ok) {
        return failure(
          message.issues.map((issue) => ({
            ...issue,
            path: ["message", ...issue.path],
            code: "invalid-message",
          })),
        );
      }
      return success(
        freeze({
          type: "message" as const,
          id: value.id,
          message: message.value,
          metadata: freeze(value.metadata ?? {}),
        }),
      );
    }
    return success(
      freeze({
        type: "activity" as const,
        id: value.id,
        activityType: value.activityType,
        data: freeze(value.data),
        metadata: freeze(value.metadata ?? {}),
      }),
    );
  },
);

/** Result-oriented parser for canonical Chat history entry arrays. */
export const chatHistoryEntriesParser: Parser<readonly ChatHistoryEntry[]> =
  historyEntriesStructureParser.andThen((values) => {
    const entries: ChatHistoryEntry[] = [];
    for (const [index, value] of values.entries()) {
      const parsed = chatHistoryEntryParser.parse(value);
      if (!parsed.ok) {
        return failure(parsed.issues.map((issue) => ({ ...issue, path: [index, ...issue.path] })));
      }
      entries.push(parsed.value);
    }
    return success(freeze(entries) as readonly ChatHistoryEntry[]);
  });

export function decodeChatHistoryEntry(value: unknown, path = "$"): ChatHistoryEntry {
  const parsed = chatHistoryEntryParser.parse(value);
  if (!parsed.ok) {
    throw historyError(parsed.issues, value, path);
  }
  return parsed.value;
}

export function decodeChatHistoryEntries(value: unknown, path = "$"): readonly ChatHistoryEntry[] {
  const parsed = chatHistoryEntriesParser.parse(value);
  if (!parsed.ok) {
    throw historyError(parsed.issues, value, path);
  }
  return parsed.value;
}

function historyError(
  issues: readonly ParseIssue[],
  input: unknown,
  root: string,
): ChatHistoryDecodeError {
  const issue = issues[0];
  const relativePath = issue?.path ?? [];
  const path = formatPath(root, relativePath);
  if (issue?.code === "invalid-message") {
    return new ChatHistoryDecodeError(
      "invalid-message",
      path,
      issue.message || "invalid canonical Chat message",
    );
  }
  if (issue?.code === "unrecognized_keys") {
    return new ChatHistoryDecodeError("unknown-field", path, issue.message);
  }
  if (!isRecord(input) && !Array.isArray(input)) {
    return new ChatHistoryDecodeError("invalid-value", root, issue?.message ?? "invalid value");
  }
  const owner = valueAtPath(input, relativePath.slice(0, -1));
  const key = relativePath.at(-1);
  if (
    (typeof key === "string" || typeof key === "number") &&
    isRecord(owner) &&
    !Object.prototype.hasOwnProperty.call(owner, key)
  ) {
    return new ChatHistoryDecodeError("missing-field", path, `${String(key)} is required`);
  }
  if (key === "type") {
    return new ChatHistoryDecodeError(
      "invalid-entry",
      path,
      issue?.message ?? "invalid entry type",
    );
  }
  if (relativePath.includes("metadata")) {
    return new ChatHistoryDecodeError("invalid-value", path, issue?.message ?? "invalid metadata");
  }
  return new ChatHistoryDecodeError("invalid-field", path, issue?.message ?? "invalid field");
}

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = current[segment as keyof typeof current];
  }
  return current;
}

function formatPath(root: string, path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (output, segment) =>
      typeof segment === "number" ? `${output}[${segment}]` : `${output}.${segment}`,
    root,
  );
}

function isRecord(value: unknown): value is Record<string | number, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
