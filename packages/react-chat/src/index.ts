/** @sweatpants/react-chat — the thin React facade over @sweatpants/chat-client. */
import type { ReactChatMessage, ReactChatPart } from "./headless.tsx";

export * from "./useChat.ts";
export * from "./plugin.ts";
export {
  createChatClient,
  createChatRuntime,
  type CreateReactChatClientOptions,
  type ReactChatClient,
  type ReactChatRuntime,
  type ReactChatMessage,
  type ReactChatPart,
  type ReactRenderPart,
  type ReactSchedulerDriver,
} from "./headless.tsx";
/** Framework-specialized public aliases use the native React local-part type. */
export type ChatMessage = ReactChatMessage;
export type MessagePart = ReactChatPart;
export type ChatPart = ReactChatPart;
export type TextPart = Extract<ReactChatPart, { type: "text" }>;
export type ReasoningPart = Extract<ReactChatPart, { type: "reasoning" }>;
export type StructuredOutputPart = Extract<ReactChatPart, { type: "structured-output" }>;
export type ImagePart = Extract<ReactChatPart, { type: "image" }>;
export type AudioPart = Extract<ReactChatPart, { type: "audio" }>;
export type VideoPart = Extract<ReactChatPart, { type: "video" }>;
export type DocumentPart = Extract<ReactChatPart, { type: "document" }>;
export type ToolCallPart = Extract<ReactChatPart, { type: "tool-call" }>;
export type ChatToolCall = ToolCallPart;

export type {
  ChatFetch,
  ChatTransportContract,
  ChatTransportOptions,
  ChatSnapshot,
  ChatStatus,
  ChatConnectionStatus,
  ChatRenderStatus,
  ChatBusyPolicy,
  ChatQueueOverflowPolicy,
  ChatQueueOptions,
  ChatQueueOption,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
} from "@sweatpants/chat-client";
