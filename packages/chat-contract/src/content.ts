import {
  assertJson,
  canonicalJson,
  requireJsonObject,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";

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

export function decodeChatContent(
  value: unknown,
  options: DecodeChatContentOptions = {},
): ChatContent {
  const limits = resolveLimits(options.limits);
  if (typeof value === "string") {
    assertByteLimit(value, limits.maxTextBytes, "maxTextBytes", "$");
    const output = value;
    assertContentSize(output, limits);
    return output;
  }

  const input = requireArray(value, "$");
  assertCountLimit(input.length, limits.maxParts, "maxParts", "$");
  const output = input.map((part, index) => decodePart(part, `$.${index}`, limits));
  const frozen = deepFreeze(output) as readonly ChatContentPart[];
  assertContentSize(frozen, limits);
  return frozen;
}

/** Decodes one content part; composition owners use this instead of re-wrapping arrays. */
export function decodeChatContentPart(
  value: unknown,
  path = "$",
  options: DecodeChatContentOptions = {},
): ChatContentPart {
  const limits = resolveLimits(options.limits);
  return deepFreeze(decodePart(value, path, limits));
}

function resolveLimits(requested: Partial<ChatContentLimits> | undefined): ChatContentLimits {
  const limits = { ...DEFAULT_CHAT_CONTENT_LIMITS, ...(requested ?? {}) };
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

function decodePart(value: unknown, path: string, limits: ChatContentLimits): ChatContentPart {
  const input = jsonObject(value, path);
  const type = stringValue(input["type"], `${path}.type`);
  switch (type) {
    case "text":
      assertKeys(input, ["type", "text"], path);
      return { type, text: boundedText(input["text"], limits.maxTextBytes, `${path}.text`) };
    case "image":
    case "audio":
    case "video":
    case "document":
      assertKeys(input, ["type", "source", "metadata"], path);
      return decodeMediaPart(type, input, path, limits);
    default:
      throw new ChatContentDecodeError(
        "invalid-discriminator",
        `${path}.type`,
        `unsupported content part type ${JSON.stringify(type)}`,
      );
  }
}

function decodeMediaPart(
  type: MediaType,
  input: JsonObject,
  path: string,
  limits: ChatContentLimits,
): ChatContentPart {
  const source = decodeSource(input["source"], `${path}.source`, type, limits);
  const metadata = decodeMetadata(input["metadata"], `${path}.metadata`, limits);
  return { type, source, metadata };
}

function decodeSource(
  value: unknown,
  path: string,
  modality: MediaType,
  limits: ChatContentLimits,
): ChatContentSource {
  const input = jsonObject(value, path);
  const type = stringValue(input["type"], `${path}.type`);
  switch (type) {
    case "data": {
      assertKeys(input, ["type", "value", "mimeType"], path);
      const encoded = stringValue(input["value"], `${path}.value`);
      if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
        throw new ChatContentDecodeError(
          "invalid-base64",
          `${path}.value`,
          "expected non-empty canonical RFC 4648 base64",
        );
      }
      assertByteLimit(encoded, limits.maxEncodedDataBytes, "maxEncodedDataBytes", `${path}.value`);
      const mimeType = decodeMimeType(input["mimeType"], `${path}.mimeType`, modality);
      return { type, value: encoded, mimeType };
    }
    case "url": {
      assertKeys(input, ["type", "value", "mimeType"], path);
      const value = stringValue(input["value"], `${path}.value`);
      assertByteLimit(value, limits.maxUrlBytes, "maxUrlBytes", `${path}.value`);
      assertHttpUrl(value, `${path}.value`);
      const rawMimeType = input["mimeType"];
      const mimeType =
        rawMimeType === undefined
          ? undefined
          : decodeMimeType(rawMimeType, `${path}.mimeType`, modality);
      return mimeType === undefined ? { type, value } : { type, value, mimeType };
    }
    default:
      throw new ChatContentDecodeError(
        "invalid-source",
        `${path}.type`,
        `unsupported content source type ${JSON.stringify(type)}`,
      );
  }
}

function decodeMetadata(
  value: unknown,
  path: string,
  limits: ChatContentLimits,
): JsonObject | null {
  if (value === undefined || value === null) return null;
  const metadata = jsonObject(value, path);
  const canonical = canonicalJson(metadata);
  assertByteLimit(canonical, limits.maxMetadataBytes, "maxMetadataBytes", path);
  assertDepth(metadata, limits.maxDepth, path);
  return deepFreeze(metadata) as JsonObject;
}

function decodeMimeType(value: unknown, path: string, modality: MediaType): string {
  const mimeType = stringValue(value, path);
  if (!MIME_TYPE_PATTERN.test(mimeType)) {
    throw new ChatContentDecodeError("invalid-mime-type", path, "invalid MIME type");
  }
  const family = mimeType.slice(0, mimeType.indexOf("/")).toLowerCase();
  const compatible =
    modality === "document" ? family === "application" || family === "text" : family === modality;
  if (!compatible) {
    throw new ChatContentDecodeError(
      "modality-mismatch",
      path,
      `MIME type ${mimeType} is not compatible with ${modality} content`,
    );
  }
  return mimeType;
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

function jsonObject(value: unknown, path: string): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    if (error instanceof ChatContentDecodeError) throw error;
    throw new ChatContentDecodeError(
      "invalid-value",
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ChatContentDecodeError(
      "invalid-value",
      path,
      "expected a string or content-part array",
    );
  }
  try {
    return assertJson(value, path) as Json[];
  } catch (error) {
    throw new ChatContentDecodeError(
      "invalid-value",
      path,
      error instanceof Error ? error.message : "invalid JSON array",
    );
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ChatContentDecodeError("invalid-value", path, "expected a string");
  }
  return value;
}

function boundedText(value: unknown, maximum: number, path: string): string {
  const text = stringValue(value, path);
  assertByteLimit(text, maximum, "maxTextBytes", path);
  return text;
}

function assertKeys(input: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      throw new ChatContentDecodeError("unknown-field", `${path}.${key}`, `unknown field ${key}`);
    }
  }
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
