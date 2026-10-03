import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GameChatView } from "../GameChatView";
import type { Board } from "../../../tictactoe/types";

describe("final game outcome", () => {
  it.each([false, true])("labels the actual winner when isModel=%s", (isModel) => {
    const board: Board = ["X", "X", "X", "O", "O", null, null, null, null];
    const html = renderToStaticMarkup(
      <GameChatView
        board={board}
        moveHistory={[{ position: 2, player: "X", isModel, boardAfter: board, moveNumber: 1 }]}
        userSymbol={isModel ? "O" : "X"}
        modelSymbol={isModel ? "X" : "O"}
        gameOver
        winningLine={[0, 1, 2]}
        disabled
        onRespond={vi.fn()}
      />,
    );
    expect(html).toContain(isModel ? "Model wins!" : "You win!");
    expect(html).not.toContain(isModel ? "You win!" : "Model wins!");
  });

  it("labels a full board without a winning line as a draw", () => {
    const board: Board = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
    const html = renderToStaticMarkup(
      <GameChatView
        board={board}
        moveHistory={[
          { position: 8, player: "X", isModel: false, boardAfter: board, moveNumber: 1 },
        ]}
        userSymbol="X"
        modelSymbol="O"
        gameOver
        disabled
        onRespond={vi.fn()}
      />,
    );
    expect(html).toContain("draw!");
    expect(html).not.toContain("wins!");
    expect(html).not.toContain("You win!");
  });
});
