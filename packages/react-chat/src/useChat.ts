/** Thin React external-store facade over @sweatpants/chat-client. */
export {
  useHeadlessChat as useChat,
  type UseChatOptions,
  type UseChatResult,
  type ReactChatClient,
  type ReactChatMessage,
  type ReactRenderPart,
} from "./headless.tsx";
