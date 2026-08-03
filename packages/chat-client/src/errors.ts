export type ChatClientErrorCode =
  | "chat_client_closed"
  | "chat_client_initialization_failed"
  | "chat_client_configuration_sealed"
  | "chat_driver_duplicate"
  | "chat_transport_unavailable"
  | "chat_transport_failed"
  | "chat_transport_truncated"
  | "chat_event_invalid"
  | "chat_activity_invalid"
  | "chat_activity_patch_invalid"
  | "chat_activity_conflict"
  | "chat_activity_parent_missing"
  | "chat_pipeline_failed"
  | "chat_regenerate_nested_unsupported"
  | "chat_busy_dropped"
  | "chat_queue_invalid"
  | "chat_queue_full"
  | "chat_queue_dropped";

export class ChatClientError extends Error {
  readonly code: ChatClientErrorCode | (string & {});
  override readonly cause?: unknown;

  override readonly name: string = "ChatClientError";

  constructor(code: ChatClientErrorCode | (string & {}), message: string, cause?: unknown) {
    super(`[${code}] ${message}`);
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function asChatClientError(
  error: unknown,
  fallback: ChatClientErrorCode,
  message: string,
): ChatClientError {
  if (error instanceof ChatClientError) {
    return error;
  }
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string") {
    return new ChatClientError((error as Error & { code: string }).code, error.message, error);
  }
  return new ChatClientError(fallback, message, error);
}
