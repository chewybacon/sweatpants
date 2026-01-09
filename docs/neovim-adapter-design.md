# Neovim Adapter Design (Future)

This document outlines a potential Neovim adapter for the TanStack Framework chat system.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Neovim                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Lua Plugin (chat.nvim)                                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │    │
│  │  │ UI Buffers  │  │ State Mgmt  │  │ Keymaps/Cmds    │  │    │
│  │  │ - Chat      │  │ - Messages  │  │ - :ChatSend     │  │    │
│  │  │ - Input     │  │ - Streaming │  │ - :ChatReset    │  │    │
│  │  │ - Tools     │  │ - Tools     │  │ - <CR> to send  │  │    │
│  │  └──────┬──────┘  └──────┬──────┘  └─────────────────┘  │    │
│  │         │                │                               │    │
│  │         └────────┬───────┘                               │    │
│  │                  ▼                                       │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │  RPC Layer (msgpack-rpc or HTTP)                │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Bridge Process (Node.js)                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  @tanstack/framework + neovim-client                     │    │
│  │                                                          │    │
│  │  - createChatSession (Effection)                         │    │
│  │  - Pipeline (terminal processors)                        │    │
│  │  - NDJSON streaming                                      │    │
│  │  - Neovim RPC client                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend Server (existing)                                       │
│  - Chat handler                                                  │
│  - LLM providers (Ollama, OpenAI, etc.)                         │
│  - Tool execution                                                │
└─────────────────────────────────────────────────────────────────┘
```

## Two Possible Approaches

### Option A: Node.js Bridge Process

**How it works:**
1. Neovim spawns a Node.js process as a remote plugin
2. The Node process runs the framework (Effection, pipeline, etc.)
3. Communication via msgpack-rpc (Neovim's native protocol)

**Pros:**
- Reuses 100% of the existing framework code
- Full Effection/pipeline support
- Same streaming behavior as React/Ink

**Cons:**
- Requires Node.js runtime
- Extra process to manage
- Slightly more complex setup

**Structure:**
```
packages/framework-neovim/
├── lua/
│   └── chat/
│       ├── init.lua        # Plugin entry, buffer management
│       ├── ui.lua          # Buffer rendering (messages, input)
│       ├── rpc.lua         # RPC client to Node bridge
│       └── highlights.lua  # Syntax highlighting groups
├── src/
│   └── bridge.ts           # Node.js bridge using neovim-client
├── package.json
└── plugin/
    └── chat.vim            # VimL bootstrap
```

### Option B: Pure Lua with HTTP

**How it works:**
1. Lua plugin makes HTTP requests directly to backend
2. Parses NDJSON stream in Lua
3. No Node.js dependency

**Pros:**
- No external runtime needed
- Simpler deployment
- Pure Neovim

**Cons:**
- Must reimplement streaming/state logic in Lua
- No pipeline (or must port processors to Lua)
- Harder to maintain parity with React/Ink

## Key Components

### 1. Buffer Layout

```
┌────────────────────────────────────────────┐
│ [Chat] ─────────────────────────── [Tools] │  <- Tab line
├────────────────────────────────────────────┤
│ You: What is 2+2?                          │
│                                            │
│ Assistant:                                 │
│ The answer is **4**.                       │  <- Chat buffer (readonly)
│                                            │
│ ────────────────────────────────────────── │
│ > Type your message here...                │  <- Input buffer (editable)
└────────────────────────────────────────────┘
```

### 2. Lua API (User-Facing)

```lua
-- Setup
require('chat').setup({
  backend_url = 'http://localhost:8000/api/chat',
  provider = 'ollama',
  model = 'llama3.1:latest',
  keymaps = {
    send = '<CR>',
    abort = '<C-c>',
    reset = '<leader>cr',
  },
})

-- Commands
:ChatOpen      -- Open chat window
:ChatSend      -- Send current input
:ChatReset     -- Clear conversation
:ChatAbort     -- Stop streaming
```

### 3. Terminal Rendering in Neovim

Instead of ANSI codes (like Ink), Neovim uses:
- **Extmarks** for inline styling
- **Virtual text** for annotations
- **Syntax highlighting** for code blocks
- **Tree-sitter** for accurate highlighting

```lua
-- Example: Apply bold to text
vim.api.nvim_buf_set_extmark(bufnr, ns_id, line, col, {
  end_col = end_col,
  hl_group = 'Bold',
})
```

## Design Questions

1. **Which approach?**
   - Node.js bridge (full framework parity)
   - Pure Lua (simpler, no dependencies)

2. **UI style?**
   - Split window (like layout above)
   - Floating window
   - Sidebar

3. **Code highlighting?**
   - Tree-sitter (accurate, requires parser)
   - Regex-based (simpler, less accurate)
   - Shiki via bridge (consistent with web)

4. **Tool approvals?**
   - Floating prompt
   - Echo area confirmation
   - Dedicated tools buffer

5. **Scope?**
   - Minimal (chat only)
   - Full (tools, approvals, handoffs)

## Comparison with Existing Adapters

| Aspect | React | Ink | Neovim (Option A) |
|--------|-------|-----|-------------------|
| Runtime | Browser | Node.js (Ink) | Node.js bridge + Neovim |
| Rendering | HTML/DOM | ANSI to terminal | Extmarks/Tree-sitter |
| State | React hooks | React hooks (Ink is React) | Lua state + RPC sync |
| Pipeline | markdown, shiki, mermaid, math | terminalMarkdown, terminalCode | Same as Ink via bridge |
| Components | React components | Ink components | Lua buffer functions |

## Implementation Phases

### Phase 1: Minimal Chat
- Basic chat buffer with input
- HTTP streaming to backend
- Simple text rendering (no highlighting)

### Phase 2: Rich Rendering
- Code block syntax highlighting (Tree-sitter or Shiki via bridge)
- Markdown formatting (bold, italic, links)
- Thinking/reasoning collapse

### Phase 3: Tools
- Tool call display
- Approval prompts
- Tool result rendering

### Phase 4: Full Parity
- Handoffs
- Emissions (interactive components)
- Session persistence

## Related Work

- [ChatGPT.nvim](https://github.com/jackMort/ChatGPT.nvim) - Lua-based ChatGPT plugin
- [copilot.vim](https://github.com/github/copilot.vim) - Node.js bridge pattern
- [coc.nvim](https://github.com/neoclide/coc.nvim) - Node.js extension host for Neovim

## Notes

This is a future idea documented for reference. The framework's architecture (with `createChatSession` being framework-agnostic) makes this feasible. The Node.js bridge approach (Option A) would provide the best parity with the React and Ink adapters.
