/**
 * @sweatpants/cli
 * 
 * CLI for generating TypeScript types from MCP servers with x-sweatpants extensions.
 * 
 * Usage:
 *   npx @sweatpants/cli generate --input http://localhost:8000 --output ./src/generated/mcp-types.ts
 */

import { defineCommand, runMain } from 'citty'
import { generateCommand } from './commands/generate'

const main = defineCommand({
  meta: {
    name: 'sweatpants',
    version: '0.1.0',
    description: 'CLI for generating TypeScript types from MCP servers',
  },
  subCommands: {
    generate: generateCommand,
  },
})

runMain(main)
