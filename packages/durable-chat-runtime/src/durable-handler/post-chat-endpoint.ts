import { CrankError } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import type { ScopedEndpoint } from "../streaming.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import { executeChatTurn } from "./chat-execution.ts";
import { readChatBody, type PreparedChatRequest } from "./chat-request.ts";
import { createChatStreamEndpoint } from "./chat-stream-endpoint.ts";
import { createConversationCommandErrorResponse } from "./hydrate-responses.ts";
import { bindModel, createBindingSource, stringParam } from "./model-binder.ts";

const durableParamsBinder = bindModel({
  conversationId: stringParam("x-conversation-id", "conversationId"),
});

function* preparePostChat(request: Request): Operation<PreparedChatRequest> {
  const { conversationId: parameter } = durableParamsBinder(createBindingSource(request));
  const body = yield* readChatBody(request);
  if (!body.command) {
    throw new CrankError("invalid_chat_request", "POST chat requests require a command");
  }
  const conversationId =
    body.conversationId?.trim() ||
    parameter?.trim() ||
    body.threadId?.trim() ||
    crypto.randomUUID();
  return { request, body, conversationId };
}

export function createPostChatEndpoint(execution: ChatExecutionContext): ScopedEndpoint<Request> {
  return createChatStreamEndpoint(
    execution.config,
    execution.storage,
    preparePostChat,
    function* (context) {
      const { body, selectedHead, stores, conversationId: requestedConversationId } = context;
      context.ctx.headers.set("Cache-Control", "private, no-store");
      if (body.command) {
        const now = Date.now();
        if (body.command.expiresAt <= now) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: "command_expired",
            message: `Command ${body.command.commandId} expired before admission`,
          });
        }
        if (body.command.issuedAt > now + 60_000) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: "command_issued_in_future",
            message: `Command ${body.command.commandId} issue time is not credible`,
          });
        }
      }
      const selectedCommandReceipt = body.command
        ? yield* stores.conversation.getCommandReceipt(
            requestedConversationId,
            body.command.commandId,
          )
        : null;
      // Fast rejection keeps a new ordinary command away from resume
      // planning while a Turn is visibly active. Exact retries skip
      // this optimization so the store can check receipt identity
      // before revision and state preconditions.
      if (
        selectedCommandReceipt === null &&
        body.command &&
        (body.command.type === "send-message" || body.command.type === "regenerate")
      ) {
        const selectedRevision = selectedHead?.revision ?? null;
        if (body.command.basisRevision !== selectedRevision) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: "conversation_state_changed",
            message: `Conversation ${requestedConversationId} changed after revision ${String(body.command.basisRevision)}`,
          });
        }
        if (selectedHead !== null && selectedHead.state !== "idle") {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: "conversation_not_idle",
            message: `Conversation ${requestedConversationId} is not idle`,
          });
        }
      }

      return yield* executeChatTurn(execution, context, null, selectedCommandReceipt);
    },
  );
}
