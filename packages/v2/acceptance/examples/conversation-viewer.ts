import { createChatClient } from "@sweatpan.ts/chat-client";
import type {
  ConversationView,
  ConversationAnswer,
  ConversationAnswerReceipt,
  ConversationQuestion,
} from "./file-conversation-view.ts";

/** Minimal headless consumer. No optimistic answer acceptance or implicit advancement.
 * Repeated refresh replaces a complete view; late refreshes cannot overwrite newer
 * ones. Disposal forgets display state but does not cancel server-owned execution. */
export function createConversationViewer(transport: {
  observe(): Promise<ConversationView>;
  answer(command: ConversationAnswer): Promise<ConversationAnswerReceipt>;
}) {
  const client = createChatClient({ transport });
  return {
    ...client,
    get view() {
      return client.getSnapshot().view;
    },
    answer(question: ConversationQuestion, text: string) {
      return client.answer({
        root: question.root,
        execution: question.execution,
        grant: { ...question.grant },
        text,
      });
    },
  };
}
