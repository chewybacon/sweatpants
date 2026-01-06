/**
 * Greet Tool
 *
 * A tool that demonstrates using sampling to generate a personalized greeting.
 */
import { z } from 'zod'
import { createMCPTool } from '@tanstack/framework/chat/mcp-tools'

export const greetTool = createMCPTool('greet')
  .description('Generate a personalized greeting using AI')
  .parameters(
    z.object({
      name: z.string().describe('Name of the person to greet'),
      style: z
        .enum(['formal', 'casual', 'poetic', 'pirate'])
        .default('casual')
        .describe('Style of greeting'),
    })
  )
  .requires({ sampling: true })
  .execute(function* (params, ctx) {
    yield* ctx.notify('Generating greeting...')

    const greeting = yield* ctx.sample({
      prompt: `Generate a ${params.style} greeting for someone named "${params.name}". Keep it to 1-2 sentences.`,
      maxTokens: 100,
    })

    yield* ctx.log('info', `Generated greeting for ${params.name}`)

    return {
      name: params.name,
      style: params.style,
      greeting,
    }
  })
