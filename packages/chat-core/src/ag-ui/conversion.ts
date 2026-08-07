import type { JsonObject } from "@sweatpants/foundation";

export type ChatConversionErrorCode =
  | "unsupported-role"
  | "unsupported-content"
  | "unsupported-binary-content"
  | "invalid-tool-arguments"
  | "missing-tool-identity"
  | "invalid-external-message"
  | "projection-not-reversible"
  | "ordering-violation";

export type ChatConversionDirection =
  | "ag-ui-to-chat-history"
  | "chat-history-to-ag-ui"
  | "chat-history-to-model"
  | "model-to-chat-history"
  | "chat-ui-to-ag-ui";

export class ChatConversionError extends TypeError {
  readonly code: ChatConversionErrorCode;
  readonly path: string;
  readonly direction: ChatConversionDirection;
  readonly details: JsonObject;

  constructor(
    code: ChatConversionErrorCode,
    direction: ChatConversionDirection,
    path: string,
    message: string,
    details: JsonObject = {},
  ) {
    super(`[${code}] ${direction} ${path}: ${message}`);
    this.name = "ChatConversionError";
    this.code = code;
    this.direction = direction;
    this.path = path;
    this.details = details;
  }
}
