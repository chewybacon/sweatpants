/**
 * Browser-safe Chat Core facade.
 *
 * This entry deliberately exposes only content, Chat UI, input, projection,
 * and AG-UI-facing client contracts. Durable authoring and server authority
 * remain on the package root.
 */
export {
  DEFAULT_CHAT_CONTENT_LIMITS,
  ChatContentDecodeError,
  decodeChatContent,
  decodeChatContentPart,
} from "./content.ts";
export type {
  ChatContent,
  ChatContentPart,
  ChatTextContentPart,
  ChatImageContentPart,
  ChatAudioContentPart,
  ChatVideoContentPart,
  ChatDocumentContentPart,
  ChatContentSource,
  ChatContentDataSource,
  ChatContentUrlSource,
  ChatContentLimits,
  DecodeChatContentOptions,
  ChatContentDecodeErrorCode,
  ChatContentLimitViolation,
} from "./content.ts";

export type {
  ChatUIMessage,
  ChatUIPart,
  ChatLocalPart,
  ChatUITextPart,
  ChatUIReasoningPart,
  ChatUIStructuredOutputPart,
  ChatUIImagePart,
  ChatUIAudioPart,
  ChatUIVideoPart,
  ChatUIDocumentPart,
  ChatUIMediaPart,
  ChatUIToolCallPart,
  ChatUINestedMessagePart,
  ChatUIActivityPart,
  ChatUIElicitPart,
  ChatStatus,
  ChatConnectionStatus,
  ChatRenderStatus,
  ChatBusyPolicy,
  ChatQueueOverflowPolicy,
  ChatQueueOptions,
  ChatQueueOption,
  ChatUISnapshot,
  QueuedUserMessage,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
  ConversationCommand,
  ResumeEntry,
  ChatReconnectRequest,
  ChatTransportSnapshot,
  ChatTransportControl,
  PublicActivityNode,
  PublicActivityPlacement,
  PublicMessageActivityNode,
  PublicToolActivityNode,
  PublicGenericActivityNode,
  PublicElicitActivityNode,
  ClientElicitFact,
  PublicActivityData,
  SweatpantsPublicActivity,
  JsonPatchOperation,
  FramePipeline,
  FramePipelineFactory,
} from "./client/chat-client-types.ts";

export {
  ChatProtocolError,
  decodeAGUIEvent,
  encodeAGUIEvent,
  decodePublicActivity,
  validateActivityPatch,
  decodeActivitySnapshotEvent,
  decodeActivityDeltaEvent,
} from "./client/chat-client-codec.ts";
export type { ChatProtocolErrorCode } from "./client/chat-client-codec.ts";

export {
  ChatProjectionError,
  createChatProjection,
  foldAGUIEvent,
  transitionChatProjection,
  appendAGUIMessage,
  materializeChatMessages,
  projectChatMessagesToAGUI,
  updateTextPartFrame,
  findElicitNode,
  findTextParts,
} from "./client/chat-client-projection.ts";
export type {
  ChatProjectionErrorCode,
  ChatProjectionState,
  ChatProjectionAction,
  ChatProjectionTransition,
} from "./client/chat-client-projection.ts";

export { ChatConversionError } from "./ag-ui/conversion.ts";
export type { ChatConversionErrorCode, ChatConversionDirection } from "./ag-ui/conversion.ts";

export { EventType } from "@ag-ui/core";
export type { AGUIEvent, InputContentPart, Message } from "@ag-ui/core";
