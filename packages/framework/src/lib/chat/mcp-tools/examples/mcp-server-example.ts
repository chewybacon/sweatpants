/**
 * Example: MCP Streamable HTTP Server
 *
 * Shows how to create a complete MCP server using the HTTP handler.
 * This can be integrated with any HTTP framework (Express, Hono, etc.)
 *
 * ## Key Features Demonstrated
 *
 * 1. Tool registration
 * 2. Session management
 * 3. HTTP handler creation
 * 4. Full tool execution flow
 *
 * ## Usage
 *
 * ```typescript
 * import { createMcpServer } from './mcp-server-example'
 *
 * // Create server with your tools
 * const { handler } = await createMcpServer({
 *   tools: [confirmTool, analyzeTool],
 * })
 *
 * // Use with Express
 * app.all('/mcp', (req, res) => {
 *   // Convert Express request to Fetch Request
 *   const fetchRequest = createFetchRequest(req)
 *   const response = await handler(fetchRequest)
 *   // Send response back
 * })
 *
 * // Or with Hono
 * app.all('/mcp', (c) => handler(c.req.raw))
 * ```
 */
import { z } from 'zod'
import { run } from 'effection'
import { createMcpTool } from '../mcp-tool-builder'
import { createMcpHandler } from '../handler/mcp-handler'
import { createInMemoryToolSessionStore } from '../session/in-memory-store'
import { createToolSessionRegistry } from '../session/session-registry'
import type { ToolSessionSamplingProvider, SampleResult } from '../session/types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'
import type { ElicitsMap } from '../mcp-tool-types'

// =============================================================================
// EXAMPLE TOOLS
// =============================================================================

/**
 * Simple confirmation tool with elicitation.
 */
export const confirmTool = createMcpTool('confirm_action')
  .description('Request user confirmation for an action')
  .parameters(z.object({
    action: z.string().describe('Description of the action to confirm'),
    dangerous: z.boolean().default(false).describe('Whether this is a dangerous action'),
  }))
  .elicits({
    confirmation: {
      response: z.object({
        confirmed: z.boolean().describe('Whether to proceed'),
        notes: z.string().optional().describe('Optional notes'),
      }),
    },
  })
  .execute(function* (params, ctx) {
    yield* ctx.log('info', `Requesting confirmation for: ${params.action}`)

    const prefix = params.dangerous ? 'WARNING: ' : ''
    const result = yield* ctx.elicit('confirmation', {
      message: `${prefix}${params.action}\n\nDo you want to proceed?`,
    })

    if (result.action === 'accept' && result.content.confirmed) {
      return {
        confirmed: true,
        action: params.action,
        notes: result.content.notes,
        message: `Action confirmed: ${params.action}`,
      }
    }

    return {
      confirmed: false,
      action: params.action,
      message: result.action === 'cancel' 
        ? 'User cancelled the dialog'
        : 'User did not confirm the action',
    }
  })

/**
 * Analysis tool with LLM sampling.
 */
export const analyzeTool = createMcpTool('analyze_text')
  .description('Analyze text using LLM with progress updates')
  .parameters(z.object({
    text: z.string().describe('Text to analyze'),
    aspects: z.array(z.string()).describe('Aspects to analyze (e.g., sentiment, tone, topics)'),
  }))
  .elicits({})
  .execute(function* (params, ctx) {
    yield* ctx.notify('Starting analysis...', 0.1)

    const analyses: Record<string, string> = {}

    for (let i = 0; i < params.aspects.length; i++) {
      const aspect = params.aspects[i]!
      const progress = (i + 1) / params.aspects.length

      yield* ctx.notify(`Analyzing ${aspect}...`, progress * 0.9)
      yield* ctx.log('debug', `Processing aspect: ${aspect}`)

      const result = yield* ctx.sample({
        prompt: `Analyze the following text for "${aspect}". Be concise (1-2 sentences).

Text: "${params.text}"

Analysis for ${aspect}:`,
        maxTokens: 100,
      })

      analyses[aspect] = result.text
    }

    yield* ctx.notify('Analysis complete', 1.0)

    return {
      text: params.text,
      analyses,
      aspectCount: params.aspects.length,
    }
  })

/**
 * Multi-step tool with both elicitation and sampling.
 */
export const interactiveTool = createMcpTool('interactive_task')
  .description('A multi-step task with user interaction and LLM assistance')
  .parameters(z.object({
    topic: z.string().describe('Topic to explore'),
  }))
  .elicits({
    userInput: {
      response: z.object({
        question: z.string().describe('Your question about the topic'),
      }),
    },
    feedback: {
      response: z.object({
        helpful: z.boolean().describe('Was this helpful?'),
        followUp: z.string().optional().describe('Any follow-up question?'),
      }),
    },
  })
  .execute(function* (params, ctx) {
    yield* ctx.notify('Initializing interactive session...', 0.1)

    // Get initial LLM overview
    const overview = yield* ctx.sample({
      prompt: `Give a brief (2-3 sentence) overview of: ${params.topic}`,
      maxTokens: 150,
    })

    yield* ctx.notify('Overview ready', 0.3)

    // Ask user for their question
    const userQuestion = yield* ctx.elicit('userInput', {
      message: `**Topic: ${params.topic}**\n\n${overview.text}\n\nWhat would you like to know more about?`,
    })

    if (userQuestion.action !== 'accept') {
      return {
        completed: false,
        topic: params.topic,
        overview: overview.text,
        message: 'Session ended without user question',
      }
    }

    yield* ctx.notify('Processing your question...', 0.6)

    // Get LLM answer
    const answer = yield* ctx.sample({
      prompt: `Topic: ${params.topic}
Overview: ${overview.text}

User's question: ${userQuestion.content.question}

Provide a helpful, concise answer (3-4 sentences):`,
      maxTokens: 200,
    })

    yield* ctx.notify('Getting feedback...', 0.9)

    // Get feedback
    const feedback = yield* ctx.elicit('feedback', {
      message: `**Answer:**\n${answer.text}\n\nWas this helpful? Any follow-up?`,
    })

    return {
      completed: true,
      topic: params.topic,
      overview: overview.text,
      question: userQuestion.content.question,
      answer: answer.text,
      feedback: feedback.action === 'accept' ? feedback.content : null,
    }
  })

// =============================================================================
// SERVER FACTORY
// =============================================================================

/**
 * Options for creating an MCP server.
 */
export interface McpServerOptions {
  /** Tools to register */
  tools: Array<FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>
  /** Custom sampling provider (uses mock by default) */
  samplingProvider?: ToolSessionSamplingProvider
  /** Session timeout in milliseconds */
  sessionTimeout?: number
}

/**
 * Create a mock sampling provider (for testing/demo).
 */
export function createMockSamplingProvider(): ToolSessionSamplingProvider {
  return {
    *sample(_messages, options) {
      // Simple mock - in production, this would call an actual LLM
      const maxTokens = options?.maxTokens ?? 100
      return {
        text: `[Mock LLM response, max ${maxTokens} tokens]`,
        model: 'mock-model',
      } as SampleResult
    },
  }
}

/**
 * Create an MCP server with the HTTP handler.
 *
 * @example
 * ```typescript
 * const { handler, cleanup } = await createMcpServer({
 *   tools: [confirmTool, analyzeTool],
 * })
 *
 * // Use handler with your HTTP framework
 * app.all('/mcp', handler)
 *
 * // Cleanup when done
 * await cleanup()
 * ```
 */
export async function createMcpServer(options: McpServerOptions): Promise<{
  handler: (request: Request) => Promise<Response>
  cleanup: () => Promise<void>
}> {
  const {
    tools,
    samplingProvider = createMockSamplingProvider(),
    sessionTimeout,
  } = options

  return run(function* () {
    // Create session store and registry
    const store = createInMemoryToolSessionStore()
    const registry = yield* createToolSessionRegistry(store, { samplingProvider })

    // Build tools map
    const toolsMap = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
    for (const tool of tools) {
      toolsMap.set(tool.name, tool)
    }

    // Create handler
    const handlerOptions: Parameters<typeof createMcpHandler>[0] = {
      registry,
      tools: toolsMap,
    }
    if (sessionTimeout !== undefined) {
      handlerOptions.sessionTimeout = sessionTimeout
    }
    const { handler, manager } = createMcpHandler(handlerOptions)

    return {
      handler,
      cleanup: async () => {
        await run(function* () {
          yield* manager.cleanup()
        })
      },
    }
  })
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  createMcpHandler,
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
}
