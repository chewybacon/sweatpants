import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { tictactoePlugin } from "@/tools/tictactoe/plugin";
import { playTttPlugin } from "@/tools/play-ttt/plugin";

export const Route = createFileRoute("/chat/tictactoe/")({
  component: TicTacToeDemo,
});

function TicTacToeDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "tictactoe",
        label: "Tic-Tac-Toe",
        pipeline: "markdown",
        plugins: [playTttPlugin, tictactoePlugin],
        suggestions: [{ label: "Start Game", message: "Let's play tic-tac-toe using play_ttt!" }],
      }}
    />
  );
}
