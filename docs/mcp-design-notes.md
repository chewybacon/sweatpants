Session Summary: MCP Tools Framework Implementation
What We Built
We designed and implemented a generator-based MCP (Model Context Protocol) tool authoring system for an AI chat framework. The core innovation is using JavaScript generators with yield* to naturally express multi-turn bidirectional communication with MCP clients.
Key Insight
MCP supports bidirectional communication during tool execution - servers can send elicitation/create (request user input) and sampling/createMessage (request LLM completion) requests back to the client while a tool is running. This maps perfectly to generator suspension points.
---
Files Created/Modified
Framework Core (packages/framework/src/lib/chat/mcp-tools/)
1. types.ts - Core type definitions:
   - MCPClientContext interface with elicit(), sample(), log(), notify() methods
   - ElicitResult<T> discriminated union (accept/decline/cancel)
   - MCPHandoffConfig for before/client/after pattern
   - Error classes (MCPCapabilityError, ElicitationDeclinedError, etc.)
2. builder.ts - Type-safe builder API:
   - createMCPTool(name) fluent builder
   - Phantom types for compile-time type inference
   - Support for simple .execute() or .handoff({ before, client, after })
3. mock-runtime.ts - Testing utilities:
   - createMockMCPClient() with pre-programmed responses
   - runMCPTool() executor for testing
   - Call tracking for assertions
4. index.ts - Public exports
5. __tests__/builder.test.ts - Type-level tests (10 tests)
6. __tests__/execution.test.ts - Runtime tests (17 tests)
7. __tests__/book-flight.test.ts - Example tool tests (8 tests)
8. examples/book-flight.ts - Complex example demonstrating multi-turn elicit + sample
App (apps/yo-mcp/)
1. package.json - Dependencies including @modelcontextprotocol/sdk
2. tsconfig.json - TypeScript config with path mappings
3. tsup.config.ts - Build config for CLI
4. src/cli.ts - MCP server entry point (stdio transport)
5. src/runtime/mcp-bridge.ts - Bridges framework tools to real MCP SDK:
   - Converts yield* operations to actual MCP protocol calls
   - executeGenerator() handles elicit/sample/log/notify yields
   - createMCPServerWithTools() factory
   - Has debug logging for elicitation (added to diagnose issues)
6. src/tools/ - Example tools:
   - echo.ts - Simple tool (no elicitation)
   - pick-card.ts - Card game with elicitation + handoff pattern
   - greet.ts - Uses sampling for AI greeting
   - confirm.ts - Simple confirmation flow
Config Changes
- packages/framework/package.json - Added ./chat/mcp-tools export, renamed to @sweatpants/framework
- packages/framework/tsup.config.ts - Added mcp-tools entry point
- packages/framework/docs/mcp-tools-design.md - Design spec document
Package Rename
We renamed the package from @tanstack/framework to @sweatpants/framework across all files in the monorepo:
- Updated package.json files in framework and all apps
- Updated tsconfig.json path mappings
- Updated all source file imports (48 files total)
- Ran pnpm install to update lockfile
---
Current State
All 35 framework tests pass. TypeScript compiles cleanly.
However, elicitation is not working when testing with MCP Inspector:
- Running pnpm inspect starts the server
- Calling pick_card tool returns "No card was picked" immediately
- The elicitation request appears to fail silently
- Debug logging was added to mcp-bridge.ts to diagnose
---
What's Next
1. Debug elicitation failure - Check terminal output when running:
      cd apps/yo-mcp && pnpm inspect
      Then call pick_card and look for [elicit] log messages in stderr to see what error occurs.
2. Possible issues to investigate:
   - MCP Inspector may not support elicitation capability
   - The server.elicitInput() call may need different parameters
   - May need to check client capabilities before attempting elicitation
3. Test with Claude Desktop - Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
      {
     mcpServers: {
       yo-mcp: {
         command: tsx,
         args: [src/cli.ts],
         cwd: /path/to/apps/yo-mcp
       }
     }
   }
   
---
Key Design Decisions
1. Separate createMCPTool() builder (not unified with isomorphic tools) - cleaner for now
2. Generator pattern - Each yield* is a suspension point mapped to MCP request/response
3. Three-phase handoff - before() runs once on server, client() does multi-turn MCP interaction, after() finalizes
4. ElicitResult discriminated union - Forces handling of decline/cancel cases
---
Example Usage
import { createMCPTool } from '@sweatpants/framework/chat/mcp-tools'
const bookFlight = createMCPTool('book_flight')
  .description('Book a flight')
  .parameters(z.object({ destination: z.string() }))
  .requires({ elicitation: true, sampling: true })
  .handoff({
    *before(params) {
      return { flights: searchFlights(params.destination) }
    },
    *client(handoff, ctx) {
      const selection = yield* ctx.elicit({
        message: 'Pick a flight',
        schema: z.object({ flightId: z.string() })
      })
      if (selection.action !== 'accept') return { cancelled: true }
      
      const summary = yield* ctx.sample({ prompt: 'Summarize...' })
      return { flightId: selection.content.flightId, summary }
    },
    *after(handoff, client) {
      return client.cancelled ? 'Cancelled' : `Booked ${client.flightId}`
    },
  })
---
Commands
# Run tests
cd packages/framework && pnpm vitest run src/lib/chat/mcp-tools
# Typecheck
cd apps/yo-mcp && pnpm check
# Run MCP server with inspector
cd apps/yo-mcp && pnpm inspect
# Or run directly
cd apps/yo-mcp && npx @modelcontextprotocol/inspector tsx src/cli.ts
