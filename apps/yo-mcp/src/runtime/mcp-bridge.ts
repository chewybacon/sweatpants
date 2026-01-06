/**
 * MCP Bridge Runtime
 *
 * Bridges our generator-based MCP tools to the official MCP SDK.
 * Converts yield* operations into real MCP protocol calls.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod'
import type {
  MCPClientContext,
  MCPServerContext,
  ElicitResult,
  ElicitConfig,
  SampleConfig,
  LogLevel,
  FinalizedMCPTool,
} from '@tanstack/framework/chat/mcp-tools'

// =============================================================================
// TYPES
// =============================================================================

export interface MCPBridgeOptions {
  /** Server name */
  name: string
  /** Server version */
  version: string
  /** Optional instructions for the client */
  instructions?: string
}

// =============================================================================
// CONTEXT FACTORY
// =============================================================================

/**
 * Creates an MCPClientContext that yields protocol actions.
 * The executor will intercept these and make real MCP calls.
 */
function createMCPClientContext(): MCPClientContext {
  return {
    elicit<T>(config: ElicitConfig<T>): { [Symbol.iterator](): Generator<any, ElicitResult<T>> } {
      return {
        *[Symbol.iterator](): Generator<any, ElicitResult<T>> {
          const jsonSchema = zodToJsonSchema(config.schema)

          const result: any = yield {
            type: 'elicit',
            params: {
              message: config.message,
              requestedSchema: jsonSchema,
            },
          }

          if (result.action === 'accept') {
            return {
              action: 'accept',
              content: result.content as T,
            }
          } else if (result.action === 'decline') {
            return { action: 'decline' }
          } else {
            return { action: 'cancel' }
          }
        },
      }
    },

    sample<T = string>(config: SampleConfig<T>): { [Symbol.iterator](): Generator<any, T> } {
      return {
        *[Symbol.iterator](): Generator<any, T> {
          const result: any = yield {
            type: 'sample',
            params: {
              messages: [
                {
                  role: 'user' as const,
                  content: { type: 'text' as const, text: config.prompt },
                },
              ],
              systemPrompt: config.systemPrompt,
              maxTokens: config.maxTokens ?? 1000,
              modelPreferences: config.modelPreferences,
            },
          }

          // Extract text from result
          const text = result?.content?.text ?? result?.content ?? ''

          // If schema provided, try to parse the response
          if (config.schema) {
            try {
              const parsed = JSON.parse(text)
              return config.schema.parse(parsed) as T
            } catch {
              return text as T
            }
          }

          return text as T
        },
      }
    },

    log(level: LogLevel, message: string): { [Symbol.iterator](): Generator<any, void> } {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          yield {
            type: 'log',
            params: { level, message },
          }
        },
      }
    },

    notify(message: string, progress?: number): { [Symbol.iterator](): Generator<any, void> } {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          yield {
            type: 'notify',
            params: { message, progress },
          }
        },
      }
    },
  }
}

/**
 * Convert Zod schema to JSON Schema
 */
function zodToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
  // Try Zod 4's toJSONSchema if available
  if ('toJSONSchema' in z && typeof (z as any).toJSONSchema === 'function') {
    return (z as any).toJSONSchema(schema)
  }

  // Fallback for older Zod versions
  if (schema instanceof z.ZodObject) {
    const shape = (schema as any).shape || (schema as any)._def?.shape?.()
    if (!shape) return { type: 'object' }

    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToJsonSchema(value as z.ZodType<any>)
      if (!((value as any) instanceof z.ZodOptional)) {
        required.push(key)
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }

  return { type: 'object' }
}

function zodTypeToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    return { type: 'string' }
  }
  if (schema instanceof z.ZodNumber) {
    return { type: 'number' }
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: (schema as any).options || (schema as any)._def?.values }
  }
  if (schema instanceof z.ZodOptional) {
    return zodTypeToJsonSchema((schema as any).unwrap?.() || (schema as any)._def?.innerType)
  }
  if (schema instanceof z.ZodDefault) {
    const innerType = (schema as any)._def?.innerType
    const defaultValue = (schema as any)._def?.defaultValue?.()
    const inner = zodTypeToJsonSchema(innerType)
    return { ...inner, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }
  }
  return { type: 'string' }
}

// =============================================================================
// GENERATOR EXECUTOR
// =============================================================================

/**
 * Execute a generator-based tool, handling yield* operations as MCP calls.
 */
async function executeGenerator<T>(
  iterator: Iterator<any, T>,
  server: Server
): Promise<T> {
  let result = iterator.next()

  while (!result.done) {
    const yieldedValue = result.value

    // Handle yield of protocol action
    if (yieldedValue && typeof yieldedValue === 'object' && 'type' in yieldedValue) {
      switch (yieldedValue.type) {
        case 'elicit': {
          try {
            console.error('[elicit] Requesting elicitation:', JSON.stringify(yieldedValue.params, null, 2))
            const elicitResult = await server.elicitInput({
              message: yieldedValue.params.message,
              requestedSchema: yieldedValue.params.requestedSchema,
            })
            console.error('[elicit] Got result:', JSON.stringify(elicitResult, null, 2))
            result = iterator.next(elicitResult)
          } catch (error) {
            console.error('[elicit] Elicitation error:', error)
            result = iterator.next({ action: 'cancel' })
          }
          break
        }

        case 'sample': {
          try {
            const sampleResult = await server.createMessage(yieldedValue.params)
            result = iterator.next(sampleResult)
          } catch (error) {
            console.error('Sampling error:', error)
            result = iterator.next({ content: { text: '' } })
          }
          break
        }

        case 'log': {
          try {
            await server.sendLoggingMessage({
              level: yieldedValue.params.level,
              data: yieldedValue.params.message,
            })
          } catch {
            // Ignore logging errors
          }
          result = iterator.next()
          break
        }

        case 'notify': {
          console.error(`[progress${yieldedValue.params.progress !== undefined ? `: ${yieldedValue.params.progress}` : ''}] ${yieldedValue.params.message}`)
          result = iterator.next()
          break
        }

        default:
          result = iterator.next()
      }
    } else if (yieldedValue && typeof yieldedValue === 'object' && Symbol.iterator in yieldedValue) {
      // Nested generator - execute it recursively
      const nestedResult = await executeGenerator(yieldedValue[Symbol.iterator](), server)
      result = iterator.next(nestedResult)
    } else {
      // Unknown yield, pass through
      result = iterator.next(yieldedValue)
    }
  }

  return result.value
}

// =============================================================================
// MCP SERVER FACTORY
// =============================================================================

/**
 * Create an MCP server with registered tools.
 */
export function createMCPServerWithTools(
  options: MCPBridgeOptions,
  tools: FinalizedMCPTool<string, any, any, any, any>[]
): McpServer {
  const mcpServer = new McpServer(
    {
      name: options.name,
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
      ...(options.instructions ? { instructions: options.instructions } : {}),
    }
  )

  // Register each tool
  for (const tool of tools) {
    registerToolWithMCP(mcpServer, tool)
  }

  return mcpServer
}

/**
 * Register a single tool with the MCP server.
 */
function registerToolWithMCP(
  mcpServer: McpServer,
  tool: FinalizedMCPTool<string, any, any, any, any>
): void {
  // Get the shape from the Zod schema for MCP's input
  const zodSchema = tool.parameters
  let inputSchema: any = undefined

  if (zodSchema instanceof z.ZodObject) {
    const shape = (zodSchema as any).shape || (zodSchema as any)._def?.shape?.()
    if (shape) {
      inputSchema = shape
    }
  }

  mcpServer.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema,
    },
    async (args: any) => {
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const signal = new AbortController().signal

      const serverCtx: MCPServerContext = { callId, signal }
      const clientCtx = createMCPClientContext()

      try {
        let result: any

        if (tool.handoffConfig) {
          // Execute handoff pattern
          const { before, client: clientFn, after } = tool.handoffConfig

          // Phase 1: before()
          const beforeGen = before(args, serverCtx)
          const handoff = await executeGenerator(
            beforeGen[Symbol.iterator](),
            mcpServer.server
          )

          // Client phase
          const clientGen = clientFn(handoff, clientCtx)
          const clientResult = await executeGenerator(
            clientGen[Symbol.iterator](),
            mcpServer.server
          )

          // Phase 2: after()
          const afterGen = after(handoff, clientResult, serverCtx, args)
          result = await executeGenerator(
            afterGen[Symbol.iterator](),
            mcpServer.server
          )
        } else if (tool.execute) {
          // Simple execute
          const execGen = tool.execute(args, clientCtx)
          result = await executeGenerator(
            execGen[Symbol.iterator](),
            mcpServer.server
          )
        } else {
          throw new Error(`Tool "${tool.name}" has no execute or handoff config`)
        }

        // Return result as tool content
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        }
      }
    }
  )
}
