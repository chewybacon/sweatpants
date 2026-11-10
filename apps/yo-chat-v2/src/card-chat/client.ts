import { createDemoClient } from "../chat/client.ts";
import { selectionInput } from "../cards/contracts.ts";
export const createCardChatClient = (send?: typeof fetch) =>
  createDemoClient(
    {
      endpoint: "/api/card-chat",
      storageKey: "yo-chat:card-conversations:2",
      viewEvent: "card-chat-view",
      decodeInput: (_effect, input) => selectionInput.parse(input),
    },
    send,
  );
