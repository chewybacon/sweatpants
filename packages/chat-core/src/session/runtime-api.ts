// Effection currently exposes scoped API middleware through its experimental
// entrypoint; keep this dependency isolated to the runtime interpreter seam.
import { createApi } from "effection/experimental";
import type { Channel, Operation } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import type { ChatRequestPlan } from "./machine.ts";
import type { SessionOptions } from "./options.ts";
import type { ChatTransportReceipt } from "./settlement.ts";
import { streamChatOnce } from "./stream-chat.ts";

/**
 * Scoped effect capability for one external chat request.
 *
 * The immutable session machine emits a `ChatRequestPlan`; this API interprets
 * it through the installed transport. `around()` middleware may instrument,
 * authorize, or replace the genuine external transport in the current scope.
 */
export const ChatSessionRuntimeApi = createApi("chat-core:session-runtime", {
  *runRequest(
    plan: ChatRequestPlan,
    events: Channel<ChatStateEvent, void>,
    options: SessionOptions,
  ): Operation<ChatTransportReceipt> {
    return yield* streamChatOnce([...plan.history], events, {
      ...options,
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(plan.elicitResponses ? { elicitResponses: [...plan.elicitResponses] } : {}),
      ...(plan.pluginAbort ? { pluginAbort: plan.pluginAbort } : {}),
    });
  },

  now(): number {
    return Date.now();
  },

  createId(): string {
    return crypto.randomUUID();
  },
});
