// src/__generated__/tool-worker.gen.ts
import { runWorker, createWorkerToolRegistry } from "@sweatpants/framework/chat/mcp-tools/worker";

// src/tools/book-flight/tool.ts
import { z } from "zod";
import { createMcpTool } from "@sweatpants/framework/chat";
import { sleep } from "effection";
function mockFlightSearch(from, destination) {
  return [
    {
      id: "FL001",
      airline: "SkyHigh Airways",
      flightNumber: "SH 142",
      departure: "08:00",
      arrival: "11:30",
      duration: "3h 30m",
      price: 299
    },
    {
      id: "FL002",
      airline: "CloudAir",
      flightNumber: "CA 287",
      departure: "12:45",
      arrival: "16:00",
      duration: "3h 15m",
      price: 349
    },
    {
      id: "FL003",
      airline: "JetStream",
      flightNumber: "JS 901",
      departure: "18:30",
      arrival: "22:00",
      duration: "3h 30m",
      price: 249
    }
  ];
}
function mockSeatMap() {
  return {
    rows: 10,
    seatsPerRow: ["A", "B", "C", "D", "E", "F"],
    taken: ["1A", "1B", "2C", "3D", "4A", "4B", "4C", "5F", "6A", "7B", "8C", "9D", "10E"]
  };
}
function generateTicketNumber() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result2 = "TKT-";
  for (let i = 0; i < 8; i++) {
    result2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result2;
}
var FlightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  duration: z.string(),
  price: z.number()
});
var SeatMapSchema = z.object({
  rows: z.number(),
  seatsPerRow: z.array(z.string()),
  taken: z.array(z.string())
});
var bookFlightTool = createMcpTool("book_flight").description("Book a flight for the user with interactive flight and seat selection").parameters(
  z.object({
    from: z.string().describe("Departure city or airport code"),
    destination: z.string().describe("Destination city or airport code")
  })
).elicits({
  pickFlight: {
    response: z.object({
      flightId: z.string().describe("Selected flight ID")
    }),
    context: z.object({
      flights: z.array(FlightSchema)
    })
  },
  pickSeat: {
    response: z.object({
      row: z.number().describe("Selected row number"),
      seat: z.string().describe("Selected seat letter (A-F)")
    }),
    context: z.object({
      seatMap: SeatMapSchema,
      flightInfo: z.object({
        airline: z.string(),
        flightNumber: z.string()
      }).optional()
    })
  }
}).execute(function* (params2, ctx) {
  yield* ctx.notify("Searching for flights...", 0.1);
  const flights = mockFlightSearch(params2.from, params2.destination);
  yield* ctx.notify("Found available flights", 0.2);
  yield* sleep(900);
  const flightResult = yield* ctx.elicit("pickFlight", {
    message: `Select a flight from ${params2.from} to ${params2.destination}`,
    flights
  });
  if (flightResult.action === "decline") {
    return {
      success: false,
      reason: "user_declined_flight_selection",
      message: "Flight booking cancelled - no flight selected."
    };
  }
  if (flightResult.action === "cancel") {
    return {
      success: false,
      reason: "user_cancelled",
      message: "Flight booking cancelled by user."
    };
  }
  const selectedFlight = flights.find((f) => f.id === flightResult.content.flightId);
  if (!selectedFlight) {
    return {
      success: false,
      reason: "invalid_flight_id",
      message: "Invalid flight selection."
    };
  }
  yield* ctx.notify("Flight selected, loading seat map...", 0.4);
  const seatMap = mockSeatMap();
  yield* sleep(900);
  const seatResult = yield* ctx.elicit("pickSeat", {
    message: `Select your seat on ${selectedFlight.airline} ${selectedFlight.flightNumber}`,
    seatMap,
    flightInfo: {
      airline: selectedFlight.airline,
      flightNumber: selectedFlight.flightNumber
    }
  });
  if (seatResult.action === "decline") {
    return {
      success: false,
      reason: "user_declined_seat_selection",
      message: "Flight booking cancelled - no seat selected."
    };
  }
  if (seatResult.action === "cancel") {
    return {
      success: false,
      reason: "user_cancelled",
      message: "Flight booking cancelled by user."
    };
  }
  const seatCode = `${seatResult.content.row}${seatResult.content.seat}`;
  yield* ctx.notify("Seat selected, finalizing booking...", 0.7);
  yield* ctx.notify("Getting travel tips...", 0.8);
  const tip = yield* ctx.sample({
    prompt: `Give a brief, helpful travel tip for someone arriving at ${params2.destination} airport. Keep it to 1-2 sentences.`,
    maxTokens: 100
  });
  yield* ctx.notify("Creating your booking...", 0.9);
  const ticketNumber = generateTicketNumber();
  yield* ctx.notify("Booking complete!", 1);
  return {
    success: true,
    ticketNumber,
    flight: {
      id: selectedFlight.id,
      airline: selectedFlight.airline,
      flightNumber: selectedFlight.flightNumber,
      departure: selectedFlight.departure,
      arrival: selectedFlight.arrival,
      duration: selectedFlight.duration
    },
    seat: seatCode,
    price: selectedFlight.price,
    route: {
      from: params2.from,
      to: params2.destination
    },
    travelTip: tip.text,
    message: `Successfully booked ${selectedFlight.airline} ${selectedFlight.flightNumber} from ${params2.from} to ${params2.destination}. Seat ${seatCode}. Ticket: ${ticketNumber}`
  };
});

// src/tools/calculator.ts
import { createIsomorphicTool } from "@sweatpants/framework/chat/isomorphic-tools";
import { z as z2 } from "zod";
var calculator = createIsomorphicTool("calculator").description("Evaluate a mathematical expression").parameters(
  z2.object({
    expression: z2.string().describe("The mathematical expression to evaluate")
  })
).context("headless").server(function* (params) {
  try {
    const sanitized = params.expression.replace(/[^0-9+\-*/().%\s]/g, "");
    if (sanitized !== params.expression) {
      return {
        error: "Invalid characters in expression",
        result: null
      };
    }
    const result = eval(sanitized);
    return {
      expression: params.expression,
      result: typeof result === "number" ? result : null,
      error: null
    };
  } catch (e) {
    return {
      expression: params.expression,
      result: null,
      error: e instanceof Error ? e.message : "Unknown error"
    };
  }
}).build();

// src/tools/play-ttt/tool.ts
import { z as z3 } from "zod";
import { createMcpTool as createMcpTool2 } from "@sweatpants/framework/chat";

// src/tools/tictactoe/types.ts
var EMPTY_BOARD = [null, null, null, null, null, null, null, null, null];
var WINNING_LINES = [
  [0, 1, 2],
  // rows
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  // columns
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  // diagonals
  [2, 4, 6]
];
function checkWinner(board) {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return {
        status: board[a] === "X" ? "x_wins" : "o_wins",
        winningLine: line
      };
    }
  }
  if (board.every((cell) => cell !== null)) {
    return { status: "draw" };
  }
  return { status: "ongoing" };
}
function applyMove(board, position, player) {
  if (board[position] !== null) {
    throw new Error(`Position ${position} is already occupied`);
  }
  const newBoard = [...board];
  newBoard[position] = player;
  return newBoard;
}
function formatBoard(board) {
  const symbols = board.map((cell, i) => cell === null ? String(i) : cell);
  return [
    `${symbols[0]} | ${symbols[1]} | ${symbols[2]}`,
    "---------",
    `${symbols[3]} | ${symbols[4]} | ${symbols[5]}`,
    "---------",
    `${symbols[6]} | ${symbols[7]} | ${symbols[8]}`
  ].join("\n");
}

// src/tools/play-ttt/tool.ts
var CellSchema = z3.union([z3.literal("X"), z3.literal("O"), z3.null()]);
var BoardSchema = z3.array(CellSchema).length(9).describe("Board state: 9 cells");
var LastMoveSchema = z3.object({
  position: z3.number().min(0).max(8),
  player: z3.enum(["X", "O"])
});
var GameMoveSchema = z3.object({
  position: z3.number().min(0).max(8),
  player: z3.enum(["X", "O"]),
  isModel: z3.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z3.number(),
  strategy: z3.enum(["offensive", "defensive"]).optional(),
  reasoning: z3.string().optional()
});
var MoveSchema = z3.object({
  cell: z3.number().min(0).max(8).describe("Cell position to play (0-8)")
});
var playTttTool = createMcpTool2("play_ttt").description(
  `Play a complete game of tic-tac-toe against the user.

This tool handles the entire game - just call it once and it will:
1. Randomly assign X or O to you and the user
2. Take turns until someone wins or draws
3. Return the final result

You'll use your AI reasoning to pick moves. The user will pick their moves interactively.

Board positions:
0 | 1 | 2
---------
3 | 4 | 5
---------
6 | 7 | 8`
).parameters(z3.object({})).elicits({
  pickMove: {
    response: z3.object({
      position: z3.number().min(0).max(8).describe("Cell position user clicked")
    }),
    context: z3.object({
      board: BoardSchema,
      moveHistory: z3.array(GameMoveSchema).describe("History of all moves"),
      lastMove: LastMoveSchema.optional(),
      winningLine: z3.array(z3.number()).optional(),
      gameOver: z3.boolean().optional(),
      resultMessage: z3.string().optional(),
      modelSymbol: z3.enum(["X", "O"]),
      userSymbol: z3.enum(["X", "O"])
    })
  }
}).handoff({
  /**
   * Phase 1: before()
   * Randomly assign X/O to model and user.
   * X always goes first.
   */
  *before(_params, _ctx) {
    const modelPlaysX = Math.random() < 0.5;
    return {
      modelSymbol: modelPlaysX ? "X" : "O",
      userSymbol: modelPlaysX ? "O" : "X",
      modelGoesFirst: modelPlaysX
      // X goes first
    };
  },
  /**
   * Client phase: Main game loop
   * Alternates between model and user moves until game ends.
   */
  *client(handoff, ctx) {
    const { modelSymbol, userSymbol, modelGoesFirst } = handoff;
    let board = [...EMPTY_BOARD];
    let currentPlayer = "X";
    const moveHistory = [];
    yield* ctx.log("info", `Game started! Model plays ${modelSymbol}, User plays ${userSymbol}`);
    while (true) {
      const isModelTurn = currentPlayer === modelSymbol;
      if (isModelTurn) {
        yield* ctx.notify(`Model is thinking...`, 0.5);
        const boardStr = formatBoard(board);
        const emptyPositions = board.map((cell, i) => cell === null ? i : null).filter((i) => i !== null);
        const strategy = yield* ctx.sampleTools({
          prompt: `You are playing tic-tac-toe as ${modelSymbol}.

Current board:
${boardStr}

Empty positions: ${emptyPositions.join(", ")}

Analyze the board and choose your strategy.`,
          tools: [
            {
              name: "play_offensive",
              description: "Go for the win - look for winning moves or set up future wins",
              inputSchema: z3.object({
                reasoning: z3.string().describe("Why offensive play is best here")
              })
            },
            {
              name: "play_defensive",
              description: "Block opponent threats - prevent them from winning",
              inputSchema: z3.object({
                threat: z3.string().describe("What threat are you blocking")
              })
            }
          ],
          retries: 3
        });
        const chosenStrategy = strategy.toolCalls[0];
        let playedCell;
        let strategyName;
        let reasoning;
        yield* ctx.log("info", `Strategy: ${chosenStrategy.name}`);
        strategyName = chosenStrategy.name === "play_offensive" ? "offensive" : "defensive";
        const args = chosenStrategy.arguments;
        reasoning = args.reasoning || args.threat;
        const moveResult = yield* ctx.sampleSchema({
          messages: [
            {
              role: "user",
              content: `Board:
${boardStr}

Empty positions: ${emptyPositions.join(", ")}

Pick your move.`
            },
            {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: chosenStrategy.id,
                type: "function",
                function: {
                  name: chosenStrategy.name,
                  arguments: chosenStrategy.arguments
                }
              }]
            },
            {
              role: "tool",
              content: `Strategy chosen: ${chosenStrategy.name}. Now pick a cell (0-8) from empty positions.`,
              tool_call_id: chosenStrategy.id
            }
          ],
          schema: MoveSchema,
          retries: 3
        });
        playedCell = moveResult.parsed.cell;
        if (!emptyPositions.includes(playedCell)) {
          yield* ctx.log("warning", `Model chose occupied cell ${playedCell}, falling back to first empty`);
          playedCell = emptyPositions[0];
        }
        board = applyMove(board, playedCell, modelSymbol);
        yield* ctx.log("info", `Model plays cell ${playedCell}`);
        moveHistory.push({
          position: playedCell,
          player: modelSymbol,
          isModel: true,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1,
          strategy: strategyName,
          reasoning
        });
      } else {
        const lastMove = moveHistory.length > 0 ? { position: moveHistory[moveHistory.length - 1].position, player: moveHistory[moveHistory.length - 1].player } : void 0;
        const result2 = yield* ctx.elicit("pickMove", {
          message: modelGoesFirst && board.filter((c) => c !== null).length === 1 ? `I'm ${modelSymbol}! I made the first move. Your turn as ${userSymbol}!` : `Your turn! You're playing as ${userSymbol}.`,
          board,
          moveHistory,
          lastMove,
          modelSymbol,
          userSymbol
        });
        if (result2.action === "decline" || result2.action === "cancel") {
          return {
            cancelled: true,
            board,
            boardDisplay: formatBoard(board)
          };
        }
        const userPosition = result2.content.position;
        board = applyMove(board, userPosition, userSymbol);
        yield* ctx.log("info", `User plays cell ${userPosition}`);
        moveHistory.push({
          position: userPosition,
          player: userSymbol,
          isModel: false,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1
        });
      }
      const { status, winningLine } = checkWinner(board);
      if (status !== "ongoing") {
        const resultMessage = status === "draw" ? "It's a draw! Good game!" : status === "x_wins" ? modelSymbol === "X" ? "I win! Good game!" : "You win! Well played!" : modelSymbol === "O" ? "I win! Good game!" : "You win! Well played!";
        yield* ctx.elicit("pickMove", {
          message: resultMessage,
          board,
          moveHistory,
          winningLine,
          gameOver: true,
          resultMessage,
          modelSymbol,
          userSymbol
        });
        return {
          status,
          winner: status === "draw" ? null : status === "x_wins" ? "X" : "O",
          modelWon: status !== "draw" && (status === "x_wins" && modelSymbol === "X" || status === "o_wins" && modelSymbol === "O"),
          board,
          boardDisplay: formatBoard(board),
          winningLine
        };
      }
      currentPlayer = currentPlayer === "X" ? "O" : "X";
    }
  },
  /**
   * Phase 2: after()
   * Format the final result for the LLM.
   */
  *after(handoff, clientResult, _ctx, _params) {
    const { modelSymbol, userSymbol } = handoff;
    if (clientResult.cancelled) {
      return {
        success: false,
        cancelled: true,
        message: "Game was cancelled by the user.",
        board: clientResult.board,
        boardDisplay: clientResult.boardDisplay
      };
    }
    return {
      success: true,
      modelSymbol,
      userSymbol,
      result: clientResult.status === "draw" ? "draw" : clientResult.modelWon ? "model_wins" : "user_wins",
      winner: clientResult.winner,
      board: clientResult.board,
      boardDisplay: clientResult.boardDisplay,
      winningLine: clientResult.winningLine,
      message: clientResult.status === "draw" ? "The game ended in a draw!" : clientResult.modelWon ? "I won the game!" : "The user won the game!"
    };
  }
});

// src/tools/tictactoe/tool.ts
import { z as z4 } from "zod";
import { createMcpTool as createMcpTool3 } from "@sweatpants/framework/chat";
var CellSchema2 = z4.union([z4.literal("X"), z4.literal("O"), z4.null()]);
var BoardSchema2 = z4.array(CellSchema2).length(9).describe("Board state: 9 cells");
var LastMoveSchema2 = z4.object({
  position: z4.number().min(0).max(8),
  player: z4.enum(["X", "O"])
});
var GameMoveSchema2 = z4.object({
  position: z4.number().min(0).max(8),
  player: z4.enum(["X", "O"]),
  isModel: z4.boolean(),
  boardAfter: BoardSchema2,
  moveNumber: z4.number()
});
var tictactoeTool = createMcpTool3("tictactoe").description(
  `Play a complete game of tic-tac-toe against the user.

This tool handles the entire game - just call it once and it will:
1. Randomly assign X or O to you and the user
2. Take turns until someone wins or draws
3. Return the final result

You'll pick moves by responding with a cell number. The user will pick their moves interactively.

Board positions:
0 | 1 | 2
---------
3 | 4 | 5
---------
6 | 7 | 8`
).parameters(z4.object({})).elicits({
  pickMove: {
    response: z4.object({
      position: z4.number().min(0).max(8).describe("Cell position user clicked")
    }),
    context: z4.object({
      board: BoardSchema2,
      moveHistory: z4.array(GameMoveSchema2).describe("History of all moves"),
      lastMove: LastMoveSchema2.optional(),
      winningLine: z4.array(z4.number()).optional(),
      gameOver: z4.boolean().optional(),
      resultMessage: z4.string().optional(),
      modelSymbol: z4.enum(["X", "O"]),
      userSymbol: z4.enum(["X", "O"])
    })
  }
}).handoff({
  /**
   * Phase 1: before()
   * Randomly assign X/O to model and user.
   * X always goes first.
   */
  *before(_params, _ctx) {
    const modelPlaysX = Math.random() < 0.5;
    return {
      modelSymbol: modelPlaysX ? "X" : "O",
      userSymbol: modelPlaysX ? "O" : "X",
      modelGoesFirst: modelPlaysX
      // X goes first
    };
  },
  /**
   * Client phase: Main game loop
   * Alternates between model and user moves until game ends.
   * 
   * KEY DIFFERENCE FROM play-ttt:
   * - Uses plain ctx.sample() - just free-form text response
   * - No structured output (schema), no tool forcing
   * - Must parse the response and hope for the best
   * - Falls back to random if parsing fails
   *
   * NEW: Implements exchange accumulation
   * - Captures each elicit exchange using result.exchange.withArguments()
   * - Captures model sampling turns as user/assistant messages
   * - Passes accumulated history to subsequent ctx.sample() calls
   * - Model now sees full game progression for better context
   */
  *client(handoff, ctx) {
    const { modelSymbol, userSymbol, modelGoesFirst } = handoff;
    let board = [...EMPTY_BOARD];
    let currentPlayer = "X";
    const moveHistory = [];
    const conversationHistory = [];
    yield* ctx.log("info", `Game started! Model plays ${modelSymbol}, User plays ${userSymbol}`);
    while (true) {
      const isModelTurn = currentPlayer === modelSymbol;
      if (isModelTurn) {
        yield* ctx.notify(`Model is thinking...`, 0.5);
        const boardStr = formatBoard(board);
        const emptyPositions = board.map((cell, i) => cell === null ? i : null).filter((i) => i !== null);
        const prompt = `You are playing tic-tac-toe as ${modelSymbol}.

Current board:
${boardStr}

Empty positions: ${emptyPositions.join(", ")}

Reply with ONLY a single digit (0-8) for your move. Nothing else.`;
        const response = yield* ctx.sample({
          messages: [
            ...conversationHistory,
            { role: "user", content: prompt }
          ]
        });
        conversationHistory.push(
          { role: "user", content: prompt },
          { role: "assistant", content: response.text }
        );
        yield* ctx.log("info", `Model response: "${response.text}"`);
        const match = response.text.match(/\b([0-8])\b/);
        let playedCell;
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (emptyPositions.includes(parsed)) {
            playedCell = parsed;
            yield* ctx.log("info", `Parsed valid move: ${playedCell}`);
          } else {
            yield* ctx.log("warning", `Model chose occupied cell ${parsed}, falling back to random`);
            playedCell = emptyPositions[Math.floor(Math.random() * emptyPositions.length)];
          }
        } else {
          yield* ctx.log("warning", `Could not parse move from "${response.text}", falling back to random`);
          playedCell = emptyPositions[Math.floor(Math.random() * emptyPositions.length)];
        }
        board = applyMove(board, playedCell, modelSymbol);
        yield* ctx.log("info", `Model plays cell ${playedCell}`);
        moveHistory.push({
          position: playedCell,
          player: modelSymbol,
          isModel: true,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1
        });
      } else {
        const lastMove = moveHistory.length > 0 ? { position: moveHistory[moveHistory.length - 1].position, player: moveHistory[moveHistory.length - 1].player } : void 0;
        const result2 = yield* ctx.elicit("pickMove", {
          message: modelGoesFirst && board.filter((c) => c !== null).length === 1 ? `I'm ${modelSymbol}! I made the first move. Your turn as ${userSymbol}!` : `Your turn! You're playing as ${userSymbol}.`,
          board,
          moveHistory,
          lastMove,
          modelSymbol,
          userSymbol
        });
        if (result2.action === "decline" || result2.action === "cancel") {
          return {
            cancelled: true,
            board,
            boardDisplay: formatBoard(board)
          };
        }
        const exchangeMsgs = result2.exchange.withArguments((context) => ({
          // Include human-readable board state for model context
          // Cast context.board since Zod arrays don't infer as tuples
          boardState: formatBoard(context.board),
          userSymbol: context.userSymbol,
          userMove: result2.content.position,
          moveNumber: context.moveHistory.length + 1
        }));
        conversationHistory.push(...exchangeMsgs);
        const userPosition = result2.content.position;
        board = applyMove(board, userPosition, userSymbol);
        yield* ctx.log("info", `User plays cell ${userPosition}`);
        moveHistory.push({
          position: userPosition,
          player: userSymbol,
          isModel: false,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1
        });
      }
      const { status, winningLine } = checkWinner(board);
      if (status !== "ongoing") {
        const resultMessage = status === "draw" ? "It's a draw! Good game!" : status === "x_wins" ? modelSymbol === "X" ? "I win! Good game!" : "You win! Well played!" : modelSymbol === "O" ? "I win! Good game!" : "You win! Well played!";
        yield* ctx.elicit("pickMove", {
          message: resultMessage,
          board,
          moveHistory,
          winningLine,
          gameOver: true,
          resultMessage,
          modelSymbol,
          userSymbol
        });
        return {
          status,
          winner: status === "draw" ? null : status === "x_wins" ? "X" : "O",
          modelWon: status !== "draw" && (status === "x_wins" && modelSymbol === "X" || status === "o_wins" && modelSymbol === "O"),
          board,
          boardDisplay: formatBoard(board),
          winningLine
        };
      }
      currentPlayer = currentPlayer === "X" ? "O" : "X";
    }
  },
  /**
   * Phase 2: after()
   * Format the final result for the LLM.
   */
  *after(handoff, clientResult, _ctx, _params) {
    const { modelSymbol, userSymbol } = handoff;
    if (clientResult.cancelled) {
      return {
        success: false,
        cancelled: true,
        message: "Game was cancelled by the user.",
        board: clientResult.board,
        boardDisplay: clientResult.boardDisplay
      };
    }
    return {
      success: true,
      modelSymbol,
      userSymbol,
      result: clientResult.status === "draw" ? "draw" : clientResult.modelWon ? "model_wins" : "user_wins",
      winner: clientResult.winner,
      board: clientResult.board,
      boardDisplay: clientResult.boardDisplay,
      winningLine: clientResult.winningLine,
      message: clientResult.status === "draw" ? "The game ended in a draw!" : clientResult.modelWon ? "I won the game!" : "The user won the game!"
    };
  }
});

// src/__generated__/tool-worker.gen.ts
var registry = createWorkerToolRegistry([
  { name: "book-flight_book_flight", handler: function* (params2, ctx) {
    const tool = bookFlightTool;
    if (tool && typeof tool === "object") {
      if ("execute" in tool) {
        return yield* tool.execute(params2, ctx);
      }
      if ("handoffConfig" in tool) {
        const config = tool.handoffConfig;
        const handoff = yield* config.before(params2, ctx);
        const clientResult = yield* config.client(handoff, ctx);
        return yield* config.after(handoff, clientResult, ctx, params2);
      }
      if ("server" in tool) {
        return yield* tool.server(params2, ctx);
      }
    }
    return yield* tool(params2, ctx);
  } },
  { name: "calculator", handler: function* (params2, ctx) {
    const tool = calculator;
    if (tool && typeof tool === "object") {
      if ("execute" in tool) {
        return yield* tool.execute(params2, ctx);
      }
      if ("handoffConfig" in tool) {
        const config = tool.handoffConfig;
        const handoff = yield* config.before(params2, ctx);
        const clientResult = yield* config.client(handoff, ctx);
        return yield* config.after(handoff, clientResult, ctx, params2);
      }
      if ("server" in tool) {
        return yield* tool.server(params2, ctx);
      }
    }
    return yield* tool(params2, ctx);
  } },
  { name: "play-ttt_play_ttt", handler: function* (params2, ctx) {
    const tool = playTttTool;
    if (tool && typeof tool === "object") {
      if ("execute" in tool) {
        return yield* tool.execute(params2, ctx);
      }
      if ("handoffConfig" in tool) {
        const config = tool.handoffConfig;
        const handoff = yield* config.before(params2, ctx);
        const clientResult = yield* config.client(handoff, ctx);
        return yield* config.after(handoff, clientResult, ctx, params2);
      }
      if ("server" in tool) {
        return yield* tool.server(params2, ctx);
      }
    }
    return yield* tool(params2, ctx);
  } },
  { name: "tictactoe_tictactoe", handler: function* (params2, ctx) {
    const tool = tictactoeTool;
    if (tool && typeof tool === "object") {
      if ("execute" in tool) {
        return yield* tool.execute(params2, ctx);
      }
      if ("handoffConfig" in tool) {
        const config = tool.handoffConfig;
        const handoff = yield* config.before(params2, ctx);
        const clientResult = yield* config.client(handoff, ctx);
        return yield* config.after(handoff, clientResult, ctx, params2);
      }
      if ("server" in tool) {
        return yield* tool.server(params2, ctx);
      }
    }
    return yield* tool(params2, ctx);
  } }
]);
runWorker(registry);
