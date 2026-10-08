import { CrankError } from "@sweatpants/durable-execution";
import { createEmptyStream } from "@sweatpants/durable-streams";
import type { Operation } from "effection";
import { buildConversationWindow } from "../conversation-persistence.ts";
import type { ScopedEndpoint } from "../streaming.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import { executeChatTurn } from "./chat-execution.ts";
import { readChatBody, type PreparedChatRequest } from "./chat-request.ts";
import { createChatStreamEndpoint } from "./chat-stream-endpoint.ts";
import { createStoredConversationCheckpointResponse } from "./hydrate-responses.ts";
import { waitForForeignActivation } from "./reconnect-response.ts";
import type { DurableChatReadRequest } from "./types.ts";

function* prepareReadChat(input: DurableChatReadRequest): Operation<PreparedChatRequest> {
  const submitted = yield* readChatBody(input.request);
  if (submitted.command) {
    throw new CrankError("invalid_chat_request", "Chat read requests cannot carry a command");
  }
  return {
    request: input.request,
    conversationId: input.conversationId.trim(),
    body: {
      ...submitted,
      conversationId: input.conversationId,
      ...(input.knownWindowToken ? { knownWindowToken: input.knownWindowToken } : {}),
    },
  };
}

export function createReadChatEndpoint(
  execution: ChatExecutionContext,
): ScopedEndpoint<DurableChatReadRequest> {
  const { config, projectionTokens } = execution;
  return createChatStreamEndpoint(config, execution.storage, prepareReadChat, function* (context) {
    const { body, ctx, stores, conversationId: requestedConversationId } = context;
    const selectedHead = yield* waitForForeignActivation({
      head: context.selectedHead,
      signal: context.request.signal,
      conversationId: requestedConversationId,
      liveActivations: execution.liveProgramActivations,
      journalStore: execution.programDriverJournalStore,
      conversationStore: stores.conversation,
    });
    ctx.headers.set("Cache-Control", "private, no-store");
    const storedConversationCheckpoint = selectedHead?.checkpoint
      ? yield* stores.conversation.getCheckpoint(selectedHead.checkpoint)
      : null;
    if (!storedConversationCheckpoint && !selectedHead?.activeExecutionId) {
      ctx.status = 404;
      return yield* createEmptyStream();
    }

    if (
      selectedHead &&
      storedConversationCheckpoint &&
      selectedHead.state !== "running" &&
      selectedHead.state !== "recovering"
    ) {
      const window = yield* buildConversationWindow({
        conversationId: requestedConversationId,
        head: selectedHead,
        checkpoint: storedConversationCheckpoint,
        keyring: projectionTokens,
        knownWindowToken: body.knownWindowToken || undefined,
        tokenTtlMs: config.projectionTokenTtlMs,
      });
      return yield* createStoredConversationCheckpointResponse({
        conversationId: requestedConversationId,
        head: selectedHead,
        window,
      });
    }

    return yield* executeChatTurn(execution, { ...context, selectedHead }, selectedHead, null);
  });
}
