import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";
import { tictactoePlugin } from "@/tools/tictactoe/plugin";

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
        plugins: [tictactoePlugin],
        suggestions: [{ label: "Start game", message: "Let's play tic-tac-toe!" }],
      }}
    />
  );
}
