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
import { createMCPServer } from './runtime/mcp-bridge.js'
import { originalTools, branchTools } from './tools/index.js'

const SERVER_NAME = 'yo-mcp'
const SERVER_VERSION = '0.1.0'

async function main() {
  const totalTools = originalTools.length + branchTools.length

  console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`)
  console.error(`Registered ${totalTools} tools:`)
  console.error('  Original tools:')
  for (const tool of originalTools) {
    console.error(`    - ${tool.name}: ${tool.description}`)
  }
  console.error('  Branch-based tools:')
  for (const tool of branchTools) {
    console.error(`    - ${tool.name}: ${tool.description}`)
  }

  // Create MCP server with both original and branch tools
  const mcpServer = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    instructions: `
This server demonstrates generator-based MCP tool authoring.

Available tools:

## Original Tools (MCPClientContext)
- echo: Simple echo tool
- pick_card: Draw cards and let user pick one (uses elicitation)
- greet: Generate personalized greeting (uses sampling)
- confirm: Ask user to confirm an action (uses elicitation)

## Branch-based Tools (BranchContext with sub-branching)
- pick_card_branch: Draw cards with optional LLM analysis (demonstrates sub-branches)

These tools demonstrate:
- Simple execution (echo)
- Elicitation for user input (pick_card, confirm)
- Sampling for LLM calls (greet)
- The handoff pattern (pick_card)
- Sub-branches for isolated tasks (pick_card_branch)
    `.trim(),
    tools: originalTools,
    branchTools: branchTools,
  })

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
