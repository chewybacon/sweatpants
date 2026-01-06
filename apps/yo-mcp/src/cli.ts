#!/usr/bin/env node
/**
 * yo-mcp CLI
 *
 * MCP server that demonstrates generator-based tool authoring.
 *
 * Usage:
 *   # Run with stdio transport (for MCP clients)
 *   pnpm dev
 *
 *   # Test with MCP Inspector
 *   npx @anthropic-ai/inspector pnpm dev
 *
 *   # Add to Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "yo-mcp": {
 *         "command": "node",
 *         "args": ["/path/to/yo-mcp/dist/cli.js"]
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMCPServerWithTools } from './runtime/mcp-bridge.js'
import { allTools } from './tools/index.js'

const SERVER_NAME = 'yo-mcp'
const SERVER_VERSION = '0.1.0'

async function main() {
  console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`)
  console.error(`Registered ${allTools.length} tools:`)
  for (const tool of allTools) {
    console.error(`  - ${tool.name}: ${tool.description}`)
  }

  // Create MCP server with our tools
  const mcpServer = createMCPServerWithTools(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      instructions: `
This server demonstrates generator-based MCP tool authoring.

Available tools:
- echo: Simple echo tool
- pick_card: Draw cards and let user pick one (uses elicitation)
- greet: Generate personalized greeting (uses sampling)
- confirm: Ask user to confirm an action (uses elicitation)

These tools demonstrate:
- Simple execution (echo)
- Elicitation for user input (pick_card, confirm)
- Sampling for LLM calls (greet)
- The handoff pattern (pick_card)
      `.trim(),
    },
    allTools
  )

  // Create stdio transport
  const transport = new StdioServerTransport()

  // Connect and start
  await mcpServer.connect(transport)

  console.error('Server running on stdio transport')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
