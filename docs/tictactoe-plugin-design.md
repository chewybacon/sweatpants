# TicTacToe Agentic Tool Design

## Overview

This document describes two approaches to the TicTacToe tool:

1. **`tictactoe` (multi-turn)** - Original design where LLM calls the tool multiple times
2. **`play_ttt` (agentic)** - New design where a single tool encapsulates the entire game

The `play_ttt` tool serves as the validation vehicle for the new `ctx.sample()` features and the **guaranteed helper methods**:
- `ctx.sampleTools()` for guaranteed tool calls with retry
- `ctx.sampleSchema()` for guaranteed parsed schema with retry

---

## Comparison

| Aspect | `tictactoe` (multi-turn) | `play_ttt` (agentic) |
|--------|--------------------------|----------------------|
| Tool calls | Multiple (start, move, end) | Single |
| Game state | Passed back to LLM each turn | Managed internally |
| Model moves | LLM parameters | `ctx.sampleSchema()` |
| User moves | `ctx.elicit()` | `ctx.elicit()` |
| Strategy | Implicit in LLM reasoning | Explicit via `ctx.sampleTools()` |
| Completion | LLM decides when to call end | Tool returns when game ends |

---

## `play_ttt` Design (Agentic)

### Architecture

```
apps/yo-chat/src/tools/play-ttt/
├── tool.ts              # Agentic tool with game loop
├── plugin.ts            # Client elicit handlers
├── index.ts             # Barrel exports
└── (reuse types/components from tictactoe/)
```

### Game Flow

```
┌─────────────────────────────────────────────────────────────┐
│  LLM calls play_ttt()                                       │
├─────────────────────────────────────────────────────────────┤
│  before(): Randomly assign X/O                              │
├─────────────────────────────────────────────────────────────┤
│  client(): Game Loop                                        │
│    ┌─────────────────────────────────────────────────────┐  │
│    │  If model's turn:                                   │  │
│    │    L1: ctx.sampleTools({ tools: [...] })            │  │
│    │         → Guaranteed toolCalls[0] exists            │  │
│    │    L2: ctx.sampleSchema({ schema: MoveSchema })     │  │
│    │         → Guaranteed parsed.cell exists             │  │
│    │    Apply move, check win                            │  │
│    ├─────────────────────────────────────────────────────┤  │
│    │  If user's turn:                                    │  │
│    │    ctx.elicit('pickMove', { board })                │  │
│    │    Apply move, check win                            │  │
│    ├─────────────────────────────────────────────────────┤  │
│    │  Loop until: win/lose/draw/cancel                   │  │
│    └─────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  after(): Format result { winner, board, modelWasX }        │
└─────────────────────────────────────────────────────────────┘
```

### Tool Definition

```typescript
export const playTttTool = createMcpTool('play_ttt')
  .description('Play a complete game of tic-tac-toe. Encapsulates the entire game from start to finish.')
  .parameters(z.object({}))  // No params needed - tool handles everything
  .elicits({
    pickMove: {
      response: z.object({ position: z.number().min(0).max(8) }),
      context: z.object({
        board: BoardSchema,
        lastMove: LastMoveSchema.optional(),
        gameOver: z.boolean().optional(),
        winner: z.enum(['X', 'O', 'draw']).optional(),
      }),
    },
  })
  .handoff({
    *before(_params, _ctx) {
      const modelPlaysX = Math.random() > 0.5
      return { 
        modelPlaysX, 
        modelSymbol: modelPlaysX ? 'X' as const : 'O' as const,
        userSymbol: modelPlaysX ? 'O' as const : 'X' as const,
      }
    },
    *client(handoff, ctx) {
      // Game loop - see implementation below
    },
    *after(handoff, clientResult, _ctx) {
      return {
        ...clientResult,
        modelWasX: handoff.modelPlaysX,
      }
    },
  })
```

### Decision Tree (2 Levels) - Using Guaranteed Helpers

**Level 1: Strategy** - validates `ctx.sampleTools()`

```typescript
// sampleTools guarantees toolCalls[0] exists
const strategy = yield* ctx.sampleTools({
  prompt: `You are playing tic-tac-toe as ${modelSymbol}.\n\nBoard:\n${formatBoard(board)}\n\nChoose your strategy.`,
  tools: [
    { 
      name: 'play_offensive', 
      description: 'Go for the win or set up a winning position',
      inputSchema: z.object({ reasoning: z.string() }),
    },
    { 
      name: 'play_defensive', 
      description: 'Block opponent threats or prevent losing',
      inputSchema: z.object({ threat: z.string() }),
    },
  ],
  retries: 3,  // Will retry up to 3 times if model doesn't call a tool
})

// Guaranteed to exist - no null check needed!
const strategyCall = strategy.toolCalls[0]
```

**Level 2: Move** - validates `ctx.sampleSchema()`

```typescript
const MoveSchema = z.object({ 
  cell: z.number().min(0).max(8).describe('The cell to place your mark (0-8)'),
})

// sampleSchema guarantees parsed is non-null
const move = yield* ctx.sampleSchema({
  messages: [
    { role: 'user', content: `Board:\n${formatBoard(board)}\nEmpty cells: ${emptyCells.join(', ')}` },
    { role: 'assistant', tool_calls: [{ id: strategyCall.id, type: 'function', function: { name: strategyCall.name, arguments: strategyCall.arguments } }] },
    { role: 'tool', tool_call_id: strategyCall.id, content: `Strategy: ${strategyCall.name}. Now pick an empty cell.` },
  ],
  schema: MoveSchema,
  retries: 3,  // Will retry up to 3 times if parsing fails
})

// Guaranteed to exist - no null check needed!
const cell = move.parsed.cell
```

### No More Manual Retry Loops!

The old pattern required manual retry logic:

```typescript
// OLD: Manual retry loop (now obsolete)
const MAX_RETRIES = 3

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  const move = yield* ctx.sample({ schema: MoveSchema, ... })
  if (move.parseError) {
    continue  // Retry
  }
  const cell = move.parsed!.cell
  if (board[cell] !== null) {
    continue  // Cell occupied, retry
  }
  return cell
}
// Fallback...
```

The new pattern is cleaner:

```typescript
// NEW: Guaranteed result with automatic retries
const move = yield* ctx.sampleSchema({
  prompt: `Pick a cell. Empty cells: ${emptyCells.join(', ')}`,
  schema: MoveSchema,
  retries: 3,
})

// Guaranteed to be valid - just validate it's an empty cell
const cell = move.parsed.cell
if (!emptyCells.includes(cell)) {
  // Fallback for hallucinated positions
  cell = emptyCells[0]
}
```

### Plugin Definition

```typescript
export const playTttPlugin = makePlugin(playTttTool)
  .onElicit({
    pickMove: function* (req, ctx) {
      const context = getElicitContext<PickMoveContext>(req)
      
      // Reuse the TicTacToeBoard component
      const result = yield* ctx.render(TicTacToeBoard, {
        board: context.board,
        lastMove: context.lastMove,
        gameOver: context.gameOver,
        winner: context.winner,
      })
      
      return { action: 'accept' as const, content: result }
    },
  })
  .build()
```

---

## Testing Strategy

### Unit Tests (`sampling-structured.test.ts`)

Test the sampling features in isolation with mock provider:

```typescript
describe('ctx.sample() with schema', () => {
  it('returns parsed object for valid JSON')
  it('returns parseError for invalid JSON')  
  it('supports retry on parse failure')
})

describe('ctx.sample() with tools', () => {
  it('returns toolCalls when stopReason is toolUse')
  it('passes tools and toolChoice to provider')
})
```

### Playwright E2E (`play-ttt.spec.ts`)

Test full game flow with real LLM:

```typescript
test('complete game to conclusion', async ({ page }) => {
  await page.goto('/chat/play-ttt/')
  await page.getByRole('textbox').fill("let's play tic tac toe")
  await page.keyboard.press('Enter')
  
  // Wait for board
  await expect(page.locator('[data-testid="ttt-board"]')).toBeVisible()
  
  // Play moves until game ends
  // ...
  
  // Verify game completed
  await expect(page.getByText(/wins|draw/i)).toBeVisible()
})
```

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `apps/yo-chat/src/tools/play-ttt/tool.ts` | Agentic tool |
| `apps/yo-chat/src/tools/play-ttt/plugin.ts` | Elicit handlers |
| `apps/yo-chat/src/tools/play-ttt/index.ts` | Exports |
| `apps/yo-chat/src/routes/chat/play-ttt/index.tsx` | Route |
| `apps/yo-chat/e2e/play-ttt.spec.ts` | E2E tests |
| `packages/framework/.../sampling-structured.test.ts` | Unit tests |

### Reuse from `tictactoe/`

| File | What to Reuse |
|------|---------------|
| `types.ts` | Board, checkWinner, applyMove, formatBoard |
| `components/TicTacToeBoard.tsx` | Board UI component |

---

## Relationship to `tictactoe` (Multi-Turn)

The existing `tictactoe` tool remains as-is. It demonstrates the multi-turn MCP pattern where:
- LLM controls the game flow via multiple tool calls
- Tool just handles one action at a time (start/move/end)
- State passed back to LLM in tool results

The new `play_ttt` tool demonstrates the agentic pattern where:
- Single tool call encapsulates entire workflow
- Tool internally uses `ctx.sampleTools()` and `ctx.sampleSchema()` for decisions
- More suitable for complex workflows that shouldn't require LLM orchestration

Both patterns are valid - choice depends on use case complexity and desired control flow.

---

## MCP Protocol Note

The `play_ttt` tool uses **framework extensions beyond the MCP spec**:

- `ctx.sampleTools()` - uses `tools` and `toolChoice` (not in MCP sampling spec)
- `ctx.sampleSchema()` - uses `schema` for structured output (not in MCP sampling spec)

These extensions are necessary for the L1/L2 decision tree pattern. The tool will work with our framework runtime but may have limited functionality with standard MCP clients.

See [sampling-tools-design.md](./sampling-tools-design.md#mcp-spec-considerations) for full details on the protocol divergence.
