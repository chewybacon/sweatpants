import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { pickCardPlugin } from "@/tools/pick-card";

export const Route = createFileRoute("/chat/threaded/")({
  component: ThreadedChatDemo,
});

function ThreadedChatDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "threaded",
        label: "Threaded Chat",
        pipeline: "full",
        plugins: [pickCardPlugin],
        suggestions: [
          { label: "Draw a card", message: "Ask the card picker to draw a card." },
          { label: "Pick a card", message: "Draw a card and let me pick one." },
        ],
      }}
    />
  );
}
