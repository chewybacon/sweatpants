import { ChatDemoPage } from "../chat/ChatDemoPage.tsx";
import { cardUI } from "../cards/card-ui.tsx";
import { createCardChatClient } from "./client.ts";
const plugins = [cardUI];
export function CardChat({ fetch }: { fetch?: typeof globalThis.fetch }) {
  return (
    <ChatDemoPage
      fetch={fetch}
      createClient={createCardChatClient}
      plugins={plugins}
      title="Card Picker"
      subtitle="A conversation with a little magic in the middle."
      emptyTitle="What will you draw?"
      emptyDescription="Ask for a few cards, choose your favorite, and keep the conversation going."
      placeholder="Ask me to pick a card…"
      waitingLabel="Choose a card above to continue."
      toolLabel="Pick card"
      workingLabel="Drawing cards…"
      completedLabel="Selection recorded"
      suggestions={[
        { label: "Pick a card", prompt: "Pick a card for me" },
        { label: "Card game", prompt: "I want to play a card game" },
      ]}
    />
  );
}
