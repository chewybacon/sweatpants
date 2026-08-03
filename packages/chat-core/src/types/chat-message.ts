/**
 * lib/chat/types/chat-message.ts
 *
 * Parts-based message types for chat UIs.
 *
 * Messages are composed of ordered parts, where each part represents
 * a distinct segment of content (text, reasoning, tool calls, etc.).
 *
 * This model:
 * - Handles mode switching (reasoning → text → tool → text)
 * - Allows each content part to have its own rendered Frame
 * - Aligns with Vercel AI SDK v6's parts model
 *
 * @example
 * ```tsx
 * function Message({ message }: { message: ChatMessage }) {
 *   return (
 *     <div>
 *       {message.parts.map((part, i) => {
 *         switch (part.type) {
 *           case 'text':
 *             return <FrameRenderer key={part.id} frame={part.frame} />
 *           case 'reasoning':
 *             return <ThinkingBlock key={part.id} frame={part.frame} collapsed />
 *           case 'tool-call':
 *             return <ToolCallBlock key={part.id} part={part} />
 *         }
 *       })}
 *     </div>
 *   )
 * }
 * ```
 */

import type { Frame } from "../frame.ts";
import type { RecursiveExecutionNode, TreePlacement } from "../recursive-tree.ts";

// =============================================================================
// PART ID GENERATION
// =============================================================================

let partIdCounter = 0;

/**
 * Generate a unique part ID.
 */
export function generatePartId(): string {
  return `part-${++partIdCounter}-${Date.now()}`;
}

/**
 * Reset part ID counter (for testing).
 */
export function resetPartIdCounter(): void {
  partIdCounter = 0;
}

// =============================================================================
// =============================================================================
// MESSAGE PART TYPES
// =============================================================================

/**
 * Base interface for all message parts.
 */
interface BaseMessagePart {
  /** Unique part identifier (stable across updates) */
  id: string;
}

/**
 * A text content part.
 *
 * Contains the main response text from the model, rendered through the pipeline.
 */
export interface TextPart extends BaseMessagePart {
  type: "text";
  /** Raw text content */
  content: string;
  /** Rendered HTML from the pipeline (or escaped content as fallback) */
  rendered: string;
  /** Rendered frame (contains blocks with HTML) - internal, use `rendered` instead */
  frame?: Frame;
}

/**
 * A reasoning/thinking content part.
 *
 * Contains model reasoning (e.g., Claude's extended thinking, DeepSeek-R1).
 * Also rendered through the pipeline for markdown/code highlighting.
 */
export interface ReasoningPart extends BaseMessagePart {
  type: "reasoning";
  /** Raw reasoning content */
  content: string;
  /** Rendered HTML from the pipeline (or escaped content as fallback) */
  rendered: string;
  /** Rendered frame (contains blocks with HTML) - internal, use `rendered` instead */
  frame?: Frame;
}

/**
 * A tool call part.
 *
 * Represents a tool invocation by the model and its host-owned execution anchor.
 */
export interface ToolCallPart extends BaseMessagePart {
  type: "tool-call";
  /** Tool call ID (from the model) */
  callId: string;
  /** Tool name */
  name: string;
  /** Arguments passed to the tool */
  arguments: unknown;
  /** Current execution state */
  state: "pending" | "running" | "complete" | "error";
  /** Tool result (when complete) */
  result?: unknown;
  /** Error message (when error) */
  error?: string;
  /** Recursive execution anchor owned by the host projection. */
  execution?: RecursiveExecutionNode<unknown>;
  placement?: TreePlacement;
}

/**
 * A tool result part (for multi-turn conversations where tool results
 * are sent back to the model).
 */
export interface ToolResultPart extends BaseMessagePart {
  type: "tool-result";
  /** ID of the tool call this result is for */
  callId: string;
  /** The result value */
  result: unknown;
}

/**
 * Union of all message part types.
 *
 */
export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

/**
 * Content part types that go through the pipeline.
 */
export type ContentPart = TextPart | ReasoningPart;

/**
 * Type guard for content parts (text or reasoning).
 */
export function isContentPart(part: MessagePart): part is ContentPart {
  return part.type === "text" || part.type === "reasoning";
}

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * A chat message composed of ordered parts.
 *
 * This is the primary type for rendering chat UI. Parts are rendered in order,
 * allowing natural representation of:
 * - Reasoning followed by text
 * - Text followed by tool calls
 * - Tool results followed by more text
 *
 *
 * @example
 * ```tsx
 * function Message({ message }: { message: ChatMessage }) {
 *   return (
 *     <div className={message.role}>
 *       {message.parts.map(part => (
 *         <PartRenderer key={part.id} part={part} />
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */
export interface ChatMessage {
  /** Unique message ID */
  id: string;
  /** Message role */
  role: "user" | "assistant" | "system";
  /** Ordered list of message parts */
  parts: MessagePart[];
  /** Whether this message is currently streaming */
  active: boolean;
  /** Timestamp when created */
  createdAt?: Date;
  /** Extensible metadata */
  metadata?: Record<string, unknown>;
  /** Exact causal placement in the recursive public tree. */
  placement?: TreePlacement;
}

// =============================================================================
// STREAMING MESSAGE TYPES
// =============================================================================

/**
 * Streaming message state - the message currently being streamed.
 *
 * This is always an assistant message with parts being built up.
 *
 */
export interface ActiveMessageProjection {
  /** Role is always 'assistant' for streaming messages */
  role: "assistant";
  /** Parts accumulated so far (last one may be actively streaming) */
  parts: MessagePart[];
  /** ID of the currently streaming part (if any) */
  activePartId: string | null;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract rendered HTML from a Frame.
 * Joins all block rendered content into a single HTML string.
 */
export function getRenderedFromFrame(frame: Frame | undefined): string | null {
  if (!frame || !frame.blocks.length) {
    return null;
  }
  return frame.blocks.map((b) => b.rendered).join("");
}

/**
 * Create a new text part.
 */
export function createTextPart(content: string = "", frame?: Frame): TextPart {
  const rendered = getRenderedFromFrame(frame) ?? content;
  const part: TextPart = {
    id: generatePartId(),
    type: "text",
    content,
    rendered,
  };
  if (frame !== undefined) {
    part.frame = frame;
  }
  return part;
}

/**
 * Create a new reasoning part.
 */
export function createReasoningPart(content: string = "", frame?: Frame): ReasoningPart {
  const rendered = getRenderedFromFrame(frame) ?? content;
  const part: ReasoningPart = {
    id: generatePartId(),
    type: "reasoning",
    content,
    rendered,
  };
  if (frame !== undefined) {
    part.frame = frame;
  }
  return part;
}

/**
 * Create a new tool call part.
 */
export function createToolCallPart(callId: string, name: string, args: unknown): ToolCallPart {
  return {
    id: generatePartId(),
    type: "tool-call",
    callId,
    name,
    arguments: args,
    state: "pending",
  };
}

/**
 * Create a new tool result part.
 */
export function createToolResultPart(callId: string, result: unknown): ToolResultPart {
  return {
    id: generatePartId(),
    type: "tool-result",
    callId,
    result,
  };
}

/**
 * Get all text content from a message (for search, copy, etc.).
 */
export function getMessageTextContent(message: ChatMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.content)
    .join("\n");
}

/**
 * Get all reasoning content from a message.
 */
export function getMessageReasoningContent(message: ChatMessage): string {
  return message.parts
    .filter((part): part is ReasoningPart => part.type === "reasoning")
    .map((part) => part.content)
    .join("\n");
}

/**
 * Get all tool calls from a message.
 */
export function getMessageToolCalls(message: ChatMessage): ToolCallPart[] {
  return message.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
}
