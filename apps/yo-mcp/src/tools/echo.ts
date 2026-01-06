/**
 * Echo Tool
 *
 * A simple tool that echoes back the input.
 * Demonstrates the simplest possible MCP tool.
 */
import { z } from 'zod'
import { createMCPTool } from '@sweatpants/framework/chat/mcp-tools'

export const echoTool = createMCPTool('echo')
  .description('Echo back the input message')
  .parameters(
    z.object({
      message: z.string().describe('The message to echo'),
      uppercase: z.boolean().default(false).describe('Whether to uppercase the message'),
    })
  )
  .execute(function* (params) {
    const result = params.uppercase ? params.message.toUpperCase() : params.message
    return {
      echoed: result,
      length: result.length,
    }
  })
