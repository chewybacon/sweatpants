import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { playTttPlugin } from "@/tools/play-ttt/plugin";

export const Route = createFileRoute("/chat/play-ttt/")({
  component: PlayTttDemo,
});

function PlayTttDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "play-ttt",
        label: "Agentic Tic-Tac-Toe",
        pipeline: "markdown",
        plugins: [playTttPlugin],
        suggestions: [
          {
            label: "Start Game",
            message:
              "Start a tic-tac-toe game by calling the play_ttt tool now. Do not respond with prose.",
          },
        ],
      }}
    />
  );
}
