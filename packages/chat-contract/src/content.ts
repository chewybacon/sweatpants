import {
  assertJson,
  canonicalJson,
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

export type ChatContent = string | readonly ChatContentPart[];

export type ChatContentPart =
  | ChatTextContentPart
  | ChatImageContentPart
  | ChatAudioContentPart
  | ChatVideoContentPart
  | ChatDocumentContentPart;

export interface ChatTextContentPart {
  readonly type: "text";
  readonly text: string;
}

export interface ChatImageContentPart {
  readonly type: "image";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

export interface ChatAudioContentPart {
  readonly type: "audio";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

export interface ChatVideoContentPart {
  readonly type: "video";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

export interface ChatDocumentContentPart {
  readonly type: "document";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

export type ChatContentSource = ChatContentDataSource | ChatContentUrlSource;

export interface ChatContentDataSource {
  readonly type: "data";
  readonly value: string;
  readonly mimeType: string;
}

export interface ChatContentUrlSource {
  readonly type: "url";
  readonly value: string;
  readonly mimeType?: string;
}

export interface ChatContentLimits {
  readonly maxParts: number;
  readonly maxTextBytes: number;
  readonly maxUrlBytes: number;
  readonly maxEncodedDataBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxDepth: number;
  readonly maxContentBytes: number;
}

export const DEFAULT_CHAT_CONTENT_LIMITS: ChatContentLimits = Object.freeze({
  maxParts: 64,
  maxTextBytes: 1 * 1024 * 1024,
  maxUrlBytes: 16 * 1024,
  maxEncodedDataBytes: 8 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxDepth: 32,
  maxContentBytes: 16 * 1024 * 1024,
});

export interface DecodeChatContentOptions {
  readonly limits?: Partial<ChatContentLimits>;
}

export type ChatContentDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "invalid-discriminator"
  | "invalid-source"
  | "invalid-base64"
  | "invalid-mime-type"
  | "invalid-url"
  | "invalid-metadata"
  | "modality-mismatch"
  | "limit-exceeded"
  | "invalid-limits";

export interface ChatContentLimitViolation {
  readonly name: keyof ChatContentLimits;
  readonly actual: number;
  readonly maximum: number;
}

export class ChatContentDecodeError extends TypeError {
  readonly code: ChatContentDecodeErrorCode;
  readonly path: string;
  readonly limit?: ChatContentLimitViolation;

  constructor(
    code: ChatContentDecodeErrorCode,
    path: string,
    message: string,
    limit?: ChatContentLimitViolation,
  ) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ChatContentDecodeError";
    this.code = code;
    this.path = path;
    if (limit !== undefined) {
      this.limit = limit;
    }
  }
}

const MIME_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"]*"|[A-Za-z0-9!#$&^_.+-]+))*$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MEDIA_TYPES = ["image", "audio", "video", "document"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const contentSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("data"), value: z.string(), mimeType: z.string() }),
  z.strictObject({
    type: z.literal("url"),
    value: z.string(),
    mimeType: z.string().optional(),
  }),
]);

const contentMetadataSchema = z.record(z.string(), z.json()).nullable().optional();
const contentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image"),
    source: contentSourceSchema,
    metadata: contentMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("audio"),
    source: contentSourceSchema,
    metadata: contentMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("video"),
    source: contentSourceSchema,
    metadata: contentMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("document"),
    source: contentSourceSchema,
    metadata: contentMetadataSchema,
  }),
]);

const chatContentSchema = z.union([z.string(), z.array(contentPartSchema)]);

type StructuralChatContent = z.infer<typeof chatContentSchema>;
type StructuralChatContentPart = z.infer<typeof contentPartSchema>;
type StructuralChatContentSource = z.infer<typeof contentSourceSchema>;

const chatContentStructureParser = parser(chatContentSchema);
const chatContentArrayStructureParser = parser(z.array(contentPartSchema));
const chatContentPartStructureParser = parser(contentPartSchema);

/** Result-oriented parser for the default bounded chat content contract. */
export const chatContentParser = createChatContentParser();

/** Result-oriented parser for one default bounded chat content part. */
export const chatContentPartParser = createChatContentPartParser();

export function createChatContentParser(
  options: DecodeChatContentOptions = {},
): Parser<ChatContent> {
  const limits = resolveLimits(options.limits);
  return makeParser((value) => {
    const parsed = parseChatContentStructure(value);
    if (!parsed.ok) {
      return parsed;
    }
    try {
      return success(normalizeChatContent(parsed.value, limits));
    } catch (error) {
      if (error instanceof ChatContentDecodeError) {
        return failure(issueFromContentError(error));
      }
      throw error;
    }
  });
}

export function createChatContentPartParser(
  options: DecodeChatContentOptions = {},
): Parser<ChatContentPart> {
  const limits = resolveLimits(options.limits);
  return chatContentPartStructureParser.andThen((value) => {
    try {
      return success(normalizeChatContentPart(value, "$.0", limits));
    } catch (error) {
      if (error instanceof ChatContentDecodeError) {
        return failure(issueFromContentError(error));
      }
      throw error;
    }
  });
}

export function decodeChatContent(
  value: unknown,
  options: DecodeChatContentOptions = {},
): ChatContent {
  const limits = resolveLimits(options.limits);
  const parsed = parseChatContentStructure(value);
  if (!parsed.ok) {
    throw contentErrorFromIssues(parsed.issues, "$");
  }
  return normalizeChatContent(parsed.value, limits);
}

/** Decodes one content part; composition owners use this instead of re-wrapping arrays. */
export function decodeChatContentPart(
  value: unknown,
  path = "$",
  options: DecodeChatContentOptions = {},
): ChatContentPart {
  const limits = resolveLimits(options.limits);
  const parsed = chatContentPartStructureParser.parse(value);
  if (!parsed.ok) {
    throw contentErrorFromIssues(parsed.issues, path);
  }
  return normalizeChatContentPart(parsed.value, path, limits);
}

function resolveLimits(requested: Partial<ChatContentLimits> | undefined): ChatContentLimits {
  const limits = { ...DEFAULT_CHAT_CONTENT_LIMITS, ...requested };
  for (const name of Object.keys(DEFAULT_CHAT_CONTENT_LIMITS) as Array<keyof ChatContentLimits>) {
    const value = limits[name];
    const maximum = DEFAULT_CHAT_CONTENT_LIMITS[name];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new ChatContentDecodeError(
        "invalid-limits",
        `$.limits.${name}`,
        `expected a positive safe integer no greater than ${maximum}`,
      );
    }
  }
  return Object.freeze(limits);
}

function makeParser<T>(parse: (value: unknown) => ParseResult<T>): Parser<T> {
  return {
    parse,
    map<U>(transform: (value: T) => U): Parser<U> {
      return makeParser((input) => {
        const result = parse(input);
        return result.ok ? success(transform(result.value)) : result;
      });
    },
    andThen<U>(next: (value: T) => ParseResult<U>): Parser<U> {
      return makeParser((input) => {
        const result = parse(input);
        return result.ok ? next(result.value) : result;
      });
    },
  };
}

function parseChatContentStructure(value: unknown): ParseResult<StructuralChatContent> {
  if (Array.isArray(value)) {
    return chatContentArrayStructureParser.parse(value) as ParseResult<StructuralChatContent>;
  }
  return chatContentStructureParser.parse(value);
}

function normalizeChatContent(
  value: StructuralChatContent,
  limits: ChatContentLimits,
): ChatContent {
  if (typeof value === "string") {
    assertByteLimit(value, limits.maxTextBytes, "maxTextBytes", "$");
    assertContentSize(value, limits);
    return value;
  }

  assertCountLimit(value.length, limits.maxParts, "maxParts", "$");
  const output = value.map((part, index) => normalizeChatContentPart(part, `$.${index}`, limits));
  const frozen = deepFreeze(output) as readonly ChatContentPart[];
  assertContentSize(frozen, limits);
  return frozen;
}

function normalizeChatContentPart(
  part: StructuralChatContentPart,
  path: string,
  limits: ChatContentLimits,
): ChatContentPart {
  if (part.type === "text") {
    return {
      type: "text",
      text: boundedText(part.text, limits.maxTextBytes, `${path}.text`),
    };
  }

  const source = normalizeSource(part.source, `${path}.source`, part.type, limits);
  const metadata = normalizeMetadata(part.metadata, `${path}.metadata`, limits);
  return { type: part.type, source, metadata } as ChatContentPart;
}

function normalizeSource(
  source: StructuralChatContentSource,
  path: string,
  modality: MediaType,
  limits: ChatContentLimits,
): ChatContentSource {
  if (source.type === "data") {
    if (source.value.length === 0 || !BASE64_PATTERN.test(source.value)) {
      throw new ChatContentDecodeError(
        "invalid-base64",
        `${path}.value`,
        "expected non-empty canonical RFC 4648 base64",
      );
    }
    assertByteLimit(
      source.value,
      limits.maxEncodedDataBytes,
      "maxEncodedDataBytes",
      `${path}.value`,
    );
    return {
      type: "data",
      value: source.value,
      mimeType: decodeMimeType(source.mimeType, `${path}.mimeType`, modality),
    };
  }

  assertByteLimit(source.value, limits.maxUrlBytes, "maxUrlBytes", `${path}.value`);
  assertHttpUrl(source.value, `${path}.value`);
  if (source.mimeType === undefined) {
    return { type: "url", value: source.value };
  }
  return {
    type: "url",
    value: source.value,
    mimeType: decodeMimeType(source.mimeType, `${path}.mimeType`, modality),
  };
}

function normalizeMetadata(
  value: Record<string, Json> | null | undefined,
  path: string,
  limits: ChatContentLimits,
): JsonObject | null {
  if (value === undefined || value === null) {
    return null;
  }
  const metadata = value as JsonObject;
  const canonical = canonicalJson(metadata);
  assertByteLimit(canonical, limits.maxMetadataBytes, "maxMetadataBytes", path);
  assertDepth(metadata, limits.maxDepth, path);
  return deepFreeze(metadata) as JsonObject;
}

function decodeMimeType(value: string, path: string, modality: MediaType): string {
  if (!MIME_TYPE_PATTERN.test(value)) {
    throw new ChatContentDecodeError("invalid-mime-type", path, "invalid MIME type");
  }
  const family = value.slice(0, value.indexOf("/")).toLowerCase();
  const compatible =
    modality === "document" ? family === "application" || family === "text" : family === modality;
  if (!compatible) {
    throw new ChatContentDecodeError(
      "modality-mismatch",
      path,
      `MIME type ${value} is not compatible with ${modality}`,
    );
  }
  return value;
}

function assertHttpUrl(value: string, path: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChatContentDecodeError("invalid-url", path, "expected an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChatContentDecodeError("invalid-url", path, "expected an absolute HTTP(S) URL");
  }
}

function boundedText(value: string, maximum: number, path: string): string {
  assertByteLimit(value, maximum, "maxTextBytes", path);
  return value;
}

function assertByteLimit(
  value: string,
  maximum: number,
  name: keyof ChatContentLimits,
  path: string,
): void {
  const actual = new TextEncoder().encode(value).byteLength;
  if (actual > maximum) {
    throw new ChatContentDecodeError("limit-exceeded", path, `${name} exceeded`, {
      name,
      actual,
      maximum,
    });
  }
}

function assertCountLimit(
  actual: number,
  maximum: number,
  name: keyof ChatContentLimits,
  path: string,
): void {
  if (actual > maximum) {
    throw new ChatContentDecodeError("limit-exceeded", path, `${name} exceeded`, {
      name,
      actual,
      maximum,
    });
  }
}

function assertContentSize(value: unknown, limits: ChatContentLimits): void {
  const canonical = canonicalJson(value);
  assertByteLimit(canonical, limits.maxContentBytes, "maxContentBytes", "$");
  assertDepth(assertJson(value), limits.maxDepth, "$");
}

function assertDepth(value: Json, maximum: number, path: string, depth = 0): void {
  if (depth > maximum) {
    throw new ChatContentDecodeError("limit-exceeded", path, "maxDepth exceeded", {
      name: "maxDepth",
      actual: depth,
      maximum,
    });
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertDepth(child, maximum, `${path}.${key}`, depth + 1);
    }
  }
}

function contentErrorFromIssues(
  issues: readonly ParseIssue[],
  basePath: string,
): ChatContentDecodeError {
  const issue = issues[0] ?? { path: [], message: "invalid content" };
  const relativePath = issue.path.map(String).join(".");
  const path = relativePath.length === 0 ? basePath : `${basePath}.${relativePath}`;
  const code = structuralErrorCode(issue);
  return new ChatContentDecodeError(code, path, issue.message);
}

function structuralErrorCode(issue: ParseIssue): ChatContentDecodeErrorCode {
  if (issue.code === "unrecognized_keys") {
    return "unknown-field";
  }
  if (issue.path.includes("source") && issue.path.at(-1) === "type") {
    return "invalid-source";
  }
  if (issue.path.at(-1) === "type") {
    return "invalid-discriminator";
  }
  if (issue.path.includes("metadata")) {
    return "invalid-value";
  }
  return "invalid-value";
}

function issueFromContentError(error: ChatContentDecodeError): ParseIssue {
  return {
    path: decodeIssuePath(error.path),
    message: error.message,
    code: error.code,
  };
}

function decodeIssuePath(path: string): Array<string | number> {
  if (path === "$" || path.length === 0) {
    return [];
  }
  return path
    .replace(/^\$\.?/u, "")
    .split(/[.[\]]+/u)
    .filter(Boolean)
    .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
