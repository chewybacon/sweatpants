import type {
  DurableChatReadRequest,
  DurableHistoryPageRequest,
} from "@sweatpants/durable-chat-runtime/durable-handler";

export interface BoundChatEndpoints {
  postChat(request: Request): Promise<Response>;
  readChat(input: DurableChatReadRequest): Promise<Response>;
  pageHistory(input: DurableHistoryPageRequest): Promise<Response>;
}
