/**
 * Worker-based Tool Session Factory
 *
 * Creates tool sessions that run in an isolated execution context
 * using in-process transports. This solves the cross-scope Signal
 * problem by giving the tool generator its own clean Effection scope.
 *
 * ## How It Works
 *
 * 1. Creates an in-process transport pair (host ↔ worker)
 * 2. Starts the worker runner in a separate async context
 * 3. Creates a WorkerToolSession that bridges to ToolSession interface
 * 4. Tool generator runs in worker's `run()` with its own Effection scope
 * 5. Messages flow via postMessage-style transport
 *
 * @packageDocumentation
 */

import { type Operation, resource, call } from 'effection'
import { z } from 'zod'
import type {
  ToolSession,
  ToolSessionOptions,
} from './types'
import type { ElicitsMap } from '../mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'
import { createInProcessTransportPair } from './worker-thread-transport'
import { runWorker, createWorkerToolRegistry } from './worker-runner'
import { createWorkerToolSession } from './worker-tool-session'
import type { WorkerToolContext } from './worker-types'

// =============================================================================
// TOOL ADAPTER
// =============================================================================

/**
 * Adapt a FinalizedMcpToolWithElicits to the simple WorkerTool interface.
 *
 * The bridge-runtime provides a rich context, but for the worker we need
 * a simpler interface that uses the transport-based context.
 */
function adaptToolForWorker<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(
  tool: FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>
): { name: string; handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown> } {
  return {
    name: tool.name,
    *handler(params: unknown, ctx: WorkerToolContext) {
      // Create a context that adapts WorkerToolContext to McpToolContext
      const adaptedCtx = {
        *log(level: 'debug' | 'info' | 'warning' | 'error', message: string) {
          ctx.log(level, message)
        },

        *notify(message: string, progress?: number) {
          ctx.progress(message, progress)
        },

        *sample(config: { prompt: string; maxTokens?: number }) {
          // Convert simple prompt to messages format
          const messages = [{ role: 'user' as const, content: config.prompt }]
          // Only include maxTokens if defined (exactOptionalPropertyTypes)
          const options = config.maxTokens !== undefined
            ? { maxTokens: config.maxTokens }
            : {}
          return yield* ctx.sample(messages, options)
        },

        *elicit<K extends keyof TElicits>(
          key: K,
          options: { message: string }
        ) {
          // Get ElicitDefinition from tool's elicits definition
          // ElicitsMap is Record<string, ElicitDefinition> - extract the response schema
          const definition = tool.elicits[key]
          if (!definition) {
            throw new Error(`Unknown elicit key: ${String(key)}`)
          }

          // Extract response schema from definition
          const zodSchema = definition.response

          // Convert Zod schema to JSON schema (simplified)
          const jsonSchema = zodToJsonSchema(zodSchema)

          return yield* ctx.elicit(String(key), {
            message: options.message,
            schema: jsonSchema,
          })
        },
      }

      // Run the tool's execute function (or handoff pattern)
      if (tool.execute) {
        const result = yield* tool.execute(params as TParams, adaptedCtx as unknown as Parameters<NonNullable<typeof tool.execute>>[1])
        return result
      } else if (tool.handoffConfig) {
        // TODO: Implement handoff pattern support
        throw new Error(`Tool "${tool.name}" uses handoff pattern which is not yet supported in worker-based sessions`)
      } else {
        throw new Error(`Tool "${tool.name}" has neither execute nor handoffConfig defined`)
      }
    },
  }
}

/**
 * Convert Zod schema to JSON Schema for MCP elicitation.
 * Uses Zod's built-in toJSONSchema() method.
 * 
 * Note: Uses `any` for schema type to handle Zod v3/v4 compatibility.
 */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a tool session using the worker-based architecture.
 *
 * This is a drop-in replacement for createToolSession that uses
 * message-passing instead of direct Signal communication.
 *
 * @param tool - The tool to execute
 * @param params - Tool parameters
 * @param options - Session options
 */
export function createWorkerBasedToolSession<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(
  tool: FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>,
  params: TParams,
  options: ToolSessionOptions = {}
): Operation<ToolSession<TResult>> {
  return resource<ToolSession<TResult>>(function* (provide) {
    const sessionId = options.sessionId ?? generateSessionId()

    // Create in-process transport pair
    const [hostTransport, workerTransport] = createInProcessTransportPair()

    // Create worker registry with just this tool
    const adaptedTool = adaptToolForWorker(tool)
    const registry = createWorkerToolRegistry([adaptedTool])

    // Start the worker runner in its own async context
    // This gives it a clean Effection scope via run()
    runWorker(workerTransport, registry)

    // Wait for worker to be ready
    yield* call(() => new Promise<void>((resolve) => {
      const unsub = hostTransport.subscribe((msg) => {
        if (msg.type === 'ready') {
          unsub()
          resolve()
        }
      })
    }))

    // Create the worker tool session adapter
    const session = yield* createWorkerToolSession(hostTransport, {
      sessionId,
      toolName: tool.name,
      params,
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
      ...(options.parentMessages !== undefined && { parentMessages: options.parentMessages }),
    })

    try {
      yield* provide(session as ToolSession<TResult>)
    } finally {
      hostTransport.close()
    }
  })
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 12)
  return `session_${timestamp}_${random}`
}
