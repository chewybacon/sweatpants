import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GameChatView } from "../tools/play-ttt/components/GameChatView";
import { TicTacToeBoard } from "../tools/tictactoe/components/TicTacToeBoard";
import type { Board } from "../tools/tictactoe/types";

afterEach(cleanup);

it.each(["X", "O"] as const)(
  "keeps the submitted %s visible while waiting for the next board",
  (symbol) => {
    const board: Board = [null, null, null, null, null, null, null, null, null];
    const view = render(
      <GameChatView
        board={board}
        moveHistory={[]}
        userSymbol={symbol}
        modelSymbol={symbol === "X" ? "O" : "X"}
        onRespond={vi.fn()}
      />,
    );
    view.rerender(
      <GameChatView
        board={board}
        moveHistory={[]}
        userSymbol={symbol}
        modelSymbol={symbol === "X" ? "O" : "X"}
        onRespond={vi.fn()}
        response={{ position: 0 }}
        disabled
      />,
    );
    expect(view.container.querySelectorAll(".game-cell")[0]?.textContent).toBe(symbol);
    expect(view.container.querySelectorAll(".game-board button")).toHaveLength(0);
    expect(board[0]).toBeNull();
  },
);

it("shows the ordinary board's submitted O without replacing an authoritative cell", () => {
  const board: Board = [null, "X", null, null, null, null, null, null, null];
  const view = render(
    <TicTacToeBoard board={board} onRespond={vi.fn()} response={{ position: 0 }} disabled />,
  );
  expect(view.container.querySelectorAll(".game-cell")[0]?.textContent).toBe("O");
  expect(view.container.querySelectorAll(".game-cell")[1]?.textContent).toBe("X");
  expect(board[0]).toBeNull();
});
