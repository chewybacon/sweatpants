import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GameChatView } from "../tools/play-ttt/components/GameChatView";
import type { Board } from "../tools/tictactoe/types";

const emptyBoard: Board = [null, null, null, null, null, null, null, null, null];
const finishedBoard: Board = ["X", null, "X", "O", "O", "O", "X", null, null];

beforeEach(() => {
  cleanup();
});

describe("GameChatView game-over auto-ack", () => {
  it("auto-responds with position -1 so game-over elicits do not leave open interrupts", async () => {
    const onRespond = vi.fn();

    render(
      <GameChatView
        moveHistory={[
          {
            position: 0,
            player: "X",
            isModel: false,
            boardAfter: ["X", null, null, null, null, null, null, null, null],
            moveNumber: 1,
          },
          {
            position: 4,
            player: "O",
            isModel: true,
            boardAfter: ["X", null, null, null, "O", null, null, null, null],
            moveNumber: 2,
          },
          {
            position: 5,
            player: "O",
            isModel: true,
            boardAfter: finishedBoard,
            moveNumber: 3,
          },
        ]}
        board={finishedBoard}
        userSymbol="X"
        modelSymbol="O"
        lastMove={{ position: 5, player: "O" }}
        winningLine={[3, 4, 5]}
        gameOver
        resultMessage="I win! Good game!"
        onRespond={onRespond}
      />,
    );

    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith({ position: -1 });
    });
  });

  it("does not auto-respond while the game is still interactive", async () => {
    const onRespond = vi.fn();

    render(
      <GameChatView
        moveHistory={[]}
        board={emptyBoard}
        userSymbol="X"
        modelSymbol="O"
        gameOver={false}
        onRespond={onRespond}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRespond).not.toHaveBeenCalled();
  });
});
