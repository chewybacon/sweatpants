import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { pickCardPlugin } from "@/tools/pick-card";

export const Route = createFileRoute("/chat/cards/")({
  component: CardsChatDemo,
});

function CardsChatDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "cards",
        label: "Card Picker",
        pipeline: "markdown",
        plugins: [pickCardPlugin],
        suggestions: [
          { label: "Pick a card", message: "Pick a card for me" },
          { label: "Card game", message: "I want to play a card game" },
        ],
      }}
    />
  );
}
