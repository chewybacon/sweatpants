import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { RenderableProps } from "@sweatpants/framework/chat/browser-rendering";

import type { Board, GameMove, Player } from "./tic-tac-toe.ts";

export interface TicTacToeGameProps extends RenderableProps<{ position: number }> {
  readonly moveHistory: GameMove[];
  readonly board: Board;
  readonly userSymbol: Player;
  readonly modelSymbol: Player;
  readonly lastMove?: { readonly position: number; readonly player: Player };
  readonly winningLine?: number[];
  readonly gameOver?: boolean;
  readonly resultMessage?: string;
}

const POSITION_LABELS = [
  "top left",
  "top center",
  "top right",
  "middle left",
  "center",
  "middle right",
  "bottom left",
  "bottom center",
  "bottom right",
] as const;

const CELL_SIZE = 64;

function playerVariant(player: Player): "blue" | "purple" {
  return player === "X" ? "blue" : "purple";
}

function BoardGrid({
  board,
  lastPosition,
  winningLine,
  gameOver,
  onRespond,
  disabled,
  response,
}: {
  readonly board: Board;
  readonly lastPosition?: number;
  readonly winningLine?: number[];
  readonly gameOver?: boolean;
  readonly onRespond?: (value: { position: number }) => void;
  readonly disabled?: boolean;
  readonly response?: { position: number };
}) {
  return (
    <Grid columns={3} gap={2} width="fit-content">
      {board.map((cell, position) => {
        const isWinning = winningLine?.includes(position) ?? false;
        const isLast = position === lastPosition;
        const ringClass = isWinning
          ? "ttt-cell-winner"
          : isLast
            ? "ttt-cell-last"
            : undefined;
        if (cell !== null) {
          return (
            <Card
              key={position}
              padding={0}
              width={CELL_SIZE}
              height={CELL_SIZE}
              variant={playerVariant(cell)}
              {...(ringClass ? { className: ringClass } : {})}
            >
              <Center height="100%">
                <Heading level={4} color="inherit">
                  {cell}
                </Heading>
              </Center>
            </Card>
          );
        }
        if (disabled || gameOver) {
          return (
            <Card key={position} padding={0} width={CELL_SIZE} height={CELL_SIZE} variant="transparent">
              <Center height="100%">
                <Text type="supporting" color="disabled">
                  {position}
                </Text>
              </Center>
            </Card>
          );
        }
        const isSelected = response?.position === position;
        return (
          <ClickableCard
            key={position}
            label={`Play ${POSITION_LABELS[position]}, cell ${position}`}
            padding={0}
            width={CELL_SIZE}
            height={CELL_SIZE}
            variant={isSelected ? "muted" : "transparent"}
            onClick={() => onRespond?.({ position })}
          >
            <Center height="100%">
              <Text type="supporting" color="secondary">
                {position}
              </Text>
            </Center>
          </ClickableCard>
        );
      })}
    </Grid>
  );
}

function MoveRow({ move, isFinal, result }: {
  readonly move: GameMove;
  readonly isFinal: boolean;
  readonly result?: "model_wins" | "user_wins" | "draw";
}) {
  const resultLabel =
    isFinal && result
      ? result === "draw"
        ? "Draw"
        : result === "model_wins"
          ? "Model wins"
          : "You win"
      : undefined;
  return (
    <ListItem
      startContent={<Badge variant={playerVariant(move.player)} label={move.player} />}
      label={`${move.isModel ? "Model" : "You"} played ${POSITION_LABELS[move.position]} (${move.position})`}
      description={move.reasoning}
      endContent={
        resultLabel ? (
          <Badge variant="success" label={resultLabel} />
        ) : (
          <Text type="supporting" color="secondary">
            #{move.moveNumber}
          </Text>
        )
      }
    />
  );
}

export function TicTacToeGame({
  moveHistory,
  board,
  userSymbol,
  modelSymbol,
  lastMove,
  winningLine,
  gameOver,
  resultMessage,
  onRespond,
  disabled,
  response,
}: TicTacToeGameProps) {
  if (gameOver && !disabled && !response && onRespond) {
    queueMicrotask(() => onRespond({ position: -1 }));
  }
  const finalResult =
    !gameOver || moveHistory.length === 0
      ? undefined
      : winningLine && winningLine.length > 0
        ? moveHistory.at(-1)?.isModel
          ? ("model_wins" as const)
          : ("user_wins" as const)
        : ("draw" as const);

  return (
    <Card>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center">
          <Text type="label" color="secondary">
            Interactive durable game
          </Text>
          <HStack gap={2}>
            <Badge variant={playerVariant(modelSymbol)} label={`Model ${modelSymbol}`} />
            <Badge variant={playerVariant(userSymbol)} label={`You ${userSymbol}`} />
          </HStack>
        </HStack>

        {moveHistory.length > 0 ? (
          <List header={<Text type="label" color="secondary">Move history</Text>} hasDividers density="compact">
            {moveHistory.map((move, index) => (
              <MoveRow
                key={move.moveNumber}
                move={move}
                isFinal={index === moveHistory.length - 1}
                {...(finalResult ? { result: finalResult } : {})}
              />
            ))}
          </List>
        ) : null}

        <VStack gap={3} hAlign="center">
          <HStack gap={2} vAlign="center">
            <StatusDot
              variant={gameOver ? "neutral" : "accent"}
              label={gameOver ? "Game complete" : "Your turn"}
              isPulsing={!gameOver}
            />
            <Text type="label">{gameOver ? (resultMessage ?? "Game over") : `Your turn — you are ${userSymbol}`}</Text>
          </HStack>
          <BoardGrid
            board={board}
            {...(lastMove ? { lastPosition: lastMove.position } : {})}
            {...(winningLine ? { winningLine } : {})}
            {...(gameOver !== undefined ? { gameOver } : {})}
            onRespond={onRespond}
            {...(disabled !== undefined ? { disabled } : {})}
            {...(response ? { response } : {})}
          />
        </VStack>
      </VStack>
    </Card>
  );
}

TicTacToeGame.displayName = "TicTacToeGame";
