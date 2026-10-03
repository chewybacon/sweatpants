import { EventType } from "@ag-ui/core";
import { CrankError } from "@sweatpants/durable-execution";
import type { ConversationHead, ConversationStore } from "@sweatpants/history-store/contract";
import { ConversationStoreApi, useConversationStore } from "@sweatpants/history-store/port";
import { useExecutionStore } from "@sweatpants/journal-authority/api";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { call, type Operation } from "effection";
import { useHostScopeOwner } from "../host/host-scope.ts";
import { createDurableTurnOwner, type DurableTurnOwner } from "../response-streams/index.ts";
import {
  createStreamingEndpoint,
  HandlerContext,
  type SetupResult,
  type StreamingEndpointContext,
  type ScopedEndpoint,
} from "../streaming.ts";
import type { PreparedChatRequest } from "./chat-request.ts";
import { installChatStorageDrivers, type ResolvedChatStorage } from "./storage.ts";
import type { DurableChatHandlerConfig } from "./types.ts";

export interface ChatRequestContext extends PreparedChatRequest {
  ctx: HandlerContext;
  selectedHead: ConversationHead | null;
  stores: { conversation: ConversationStore; execution: ExecutionStore };
}

/** Owns the HTTP stream and its Host-owned Turn scope; endpoint policy stays with the caller. */
export function createChatStreamEndpoint<Input>(
  config: DurableChatHandlerConfig,
  storage: ResolvedChatStorage,
  prepare: (input: Input) => Operation<PreparedChatRequest>,
  execute: (context: ChatRequestContext) => Operation<SetupResult>,
): ScopedEndpoint<Input> {
  return createStreamingEndpoint<Input>(
    function* (input, responseContext) {
      const { request, body, conversationId } = yield* prepare(input);
      const ctx: HandlerContext = {
        request,
        headers: responseContext.headers,
        get status() {
          return responseContext.status;
        },
        set status(value: number) {
          responseContext.status = value;
        },
      };
      const hostOwner = yield* useHostScopeOwner();
      if (!hostOwner) {
        throw new Error("Durable chat requests require an explicit Host-owned Turn scope");
      }
      // Select the authority-visible active Turn after normalization and before
      // constructing its structural owner. This read never starts durable work.
      yield* installChatStorageDrivers(storage);
      const selectedHead = yield* ConversationStoreApi.operations.loadHead(conversationId);
      // From here on, request-path store access flows through the port
      // facades so the API middleware chain applies uniformly.
      const stores = {
        conversation: yield* useConversationStore(),
        execution: yield* useExecutionStore(),
      };
      const turnOwner: DurableTurnOwner = yield* createDurableTurnOwner(hostOwner, function* () {
        yield* HandlerContext.set(ctx);
        yield* installChatStorageDrivers(storage);
        if (config.setup) {
          yield* config.setup({ request, body });
        }
      });

      let requestSetupCompleted = false;
      try {
        const attempt = yield* call(() =>
          turnOwner.scope.run(function* () {
            try {
              const value = yield* execute({
                request,
                body,
                conversationId,
                ctx,
                selectedHead,
                stores,
              });
              return { ok: true as const, value };
            } catch (error) {
              // Transfer setup failures back to the HTTP scope without failing the Host-owned scope.
              return { ok: false as const, error };
            }
          }),
        );
        if (!attempt.ok) {
          throw attempt.error;
        }
        requestSetupCompleted = true;
        return attempt.value;
      } finally {
        if (requestSetupCompleted) {
          turnOwner.seal();
        } else {
          yield* turnOwner.abort();
        }
      }
    },
    {
      defaultHeaders: { "Content-Type": "application/x-ndjson" },
      serialize: (value) => value + "\n",
      onSetupError: chatSetupErrorResponse,
    },
  );
}

function chatSetupErrorResponse(error: Error, ctx: StreamingEndpointContext): Response {
  return new Response(
    JSON.stringify({
      type: EventType.RUN_ERROR,
      message: error.message,
      code: error instanceof CrankError ? error.code : "internal_error",
    }) + "\n",
    { status: 200, headers: ctx.headers },
  );
}
