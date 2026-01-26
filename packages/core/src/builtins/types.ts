import type { ZodSchema, infer as ZodInfer } from "zod";

// ============================================================================
// Elicit Types
// ============================================================================

/**
 * Options for eliciting structured data from the user.
 */
export interface ElicitOptions<TSchema extends ZodSchema> {
  /** The type of elicitation (e.g., "form", "confirmation", "selection") */
  type: string;
  /** Message or prompt to display to the user */
  message: string;
  /** Zod schema for validating the response */
  schema: TSchema;
  /** Optional metadata for the UI */
  meta?: Record<string, unknown>;
}

/**
 * Result of an elicit operation.
 */
export type ElicitResult<TSchema extends ZodSchema> =
  | { status: "accepted"; value: ZodInfer<TSchema> }
  | { status: "declined" }
  | { status: "cancelled" };

// ============================================================================
// Notify Types
// ============================================================================

/**
 * Options for sending a notification.
 */
export interface NotifyOptions {
  /** The notification message */
  message: string;
  /** Optional progress value (0-1) */
  progress?: number;
  /** Notification level */
  level?: "info" | "warning" | "error" | "success";
  /** Optional metadata */
  meta?: Record<string, unknown>;
}

/**
 * Result of a notify operation.
 */
export interface NotifyResult {
  /** Whether the notification was acknowledged */
  ok: boolean;
}

// ============================================================================
// Sample Types
// ============================================================================

/**
 * Options for requesting an LLM completion.
 */
export interface SampleOptions {
  /** The prompt or messages to send */
  prompt: string | SampleMessage[];
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for sampling (0-2) */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /** Model to use (if not default) */
  model?: string;
  /** Optional metadata */
  meta?: Record<string, unknown>;
}

/**
 * A message in a sample conversation.
 */
export interface SampleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Result of a sample operation.
 */
export interface SampleResult {
  /** The generated text */
  text: string;
  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** The model that was used */
  model?: string;
  /** Reason for stopping */
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls";
}


