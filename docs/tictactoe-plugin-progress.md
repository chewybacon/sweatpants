# TicTacToe Plugin Rewrite Progress

## Status: ✅ Phase 2 COMPLETE

## Overview

Two tic-tac-toe implementations:

1. **`tictactoe`** (Phase 1 - Complete) - Multi-turn pattern, LLM drives game via tool calls
2. **`play_ttt`** (Phase 2 - In Progress) - Agentic pattern, single tool encapsulates entire game

Phase 2 validates the new `ctx.sample()` features (schema + tools).

---

## Phase 1: Multi-Turn Tool - COMPLETE

### Files
```
apps/yo-chat/src/tools/tictactoe/
├── types.ts           # Game types and logic
├── tool.ts            # MCP tool with start/move/end actions
├── plugin.ts          # Client-side elicitation handler
├── components/
│   └── TicTacToeBoard.tsx  # Interactive board component
└── index.ts           # Barrel exports
```

### How It Works
- LLM calls `tictactoe` tool multiple times with `action: 'start' | 'move' | 'end'`
- Tool uses `ctx.elicit()` to get user moves
- Game state passed back to LLM in tool results
- LLM orchestrates the game flow

---

## Phase 2: Agentic Tool (`play_ttt`) - COMPLETE

### Purpose

Validate `ctx.sample()` with:
- `schema` for structured output (model's move selection)
- `tools` for LLM-driven decisions (strategy selection)

### Design

Single tool that encapsulates entire game:
- `before()`: Randomly assign X/O
- `client()`: Game loop with sample (model) + elicit (user)
- `after()`: Format final result

Decision tree:
1. **L1: Strategy** - `ctx.sample({ tools: [offensive, defensive] })`
2. **L2: Move** - `ctx.sample({ schema: MoveSchema })`

See [tictactoe-plugin-design.md](./tictactoe-plugin-design.md) for full design.

### Tasks

- [x] Create unit tests (`sampling-structured.test.ts`)
- [x] Create `apps/yo-chat/src/tools/play-ttt/tool.ts`
- [x] Create `apps/yo-chat/src/tools/play-ttt/plugin.ts`
- [x] Create `apps/yo-chat/src/tools/play-ttt/index.ts`
- [x] Create `apps/yo-chat/src/routes/chat/play-ttt/index.tsx`
- [x] Create Playwright E2E (`play-ttt.spec.ts`) - 8 tests passing

### Files Created
```
apps/yo-chat/src/tools/play-ttt/
├── tool.ts            # Agentic tool with game loop
├── plugin.ts          # Client elicit handlers
└── index.ts           # Barrel exports

apps/yo-chat/src/routes/chat/play-ttt/
└── index.tsx          # Route

apps/yo-chat/e2e/
└── play-ttt.spec.ts   # E2E tests (8 passing)

packages/framework/src/lib/chat/mcp-tools/__tests__/
└── sampling-structured.test.ts  # Unit tests (9 passing)
```

### Reuse from Phase 1
- `tictactoe/types.ts` - Board, checkWinner, applyMove, formatBoard
- `tictactoe/components/TicTacToeBoard.tsx` - Board UI

---

## Testing Commands

```bash
# Start the dev server
cd apps/yo-chat && pnpm dev

# Run unit tests
cd packages/framework && pnpm test src/lib/chat/mcp-tools

# Run E2E tests
cd apps/yo-chat && pnpm playwright test e2e/play-ttt.spec.ts
```

---

## Phase 3: Interruptible Elicitation (Future)

Deferred. Not needed for `play_ttt` validation.

- [ ] Add `action: 'interrupt'` to `ElicitResult` type
- [ ] Add `ctx.emitText()` primitive
- [ ] Handle mid-game chat
