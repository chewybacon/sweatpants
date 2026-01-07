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
  // Branch types
  FinalizedBranchTool,
  BranchMCPClient,
  Message,
  SampleResult,
  BranchServerContext,
} from '@sweatpants/framework/chat/mcp-tools'

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
 * Options for creating an MCP server with tools.
 */
export interface CreateMCPServerOptions extends MCPBridgeOptions {
  /** Original MCP tools (using MCPClientContext) */
  tools?: FinalizedMCPTool<string, any, any, any, any>[]
  /** Branch-based tools (using BranchContext) */
  branchTools?: FinalizedBranchTool<string, any, any, any, any>[]
}

/**
 * Create an MCP server with registered tools.
 */
export function createMCPServerWithTools(
  options: MCPBridgeOptions,
  tools: FinalizedMCPTool<string, any, any, any, any>[]
): McpServer {
  return createMCPServer({
    ...options,
    tools,
  })
}

/**
 * Create an MCP server with both original and branch-based tools.
 */
export function createMCPServer(options: CreateMCPServerOptions): McpServer {
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

  // Register original tools
  for (const tool of options.tools ?? []) {
    registerToolWithMCP(mcpServer, tool)
  }

  // Register branch-based tools
  for (const tool of options.branchTools ?? []) {
    registerBranchToolWithMCP(mcpServer, tool)
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

// =============================================================================
// BRANCH TOOL SUPPORT
// =============================================================================

/**
 * Create a BranchMCPClient that uses the real MCP server.
 */
function createBranchMCPClient(server: Server): BranchMCPClient {
  return {
    capabilities: {
      elicitation: true,
      sampling: true,
    },

    sample(
      messages: Message[],
      options?: { systemPrompt?: string; maxTokens?: number }
    ): { [Symbol.iterator](): Generator<any, SampleResult> } {
      return {
        *[Symbol.iterator](): Generator<any, SampleResult> {
          const result: any = yield {
            type: 'sample',
            params: {
              messages: messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: { type: 'text' as const, text: m.content },
              })),
              systemPrompt: options?.systemPrompt,
              maxTokens: options?.maxTokens ?? 1000,
            },
          }

          // Extract text from result
          const text = result?.content?.text ?? result?.content ?? ''

          return {
            text,
            model: result?.model,
            stopReason: result?.stopReason,
          }
        },
      }
    },

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
 * Register a branch-based tool with the MCP server.
 */
function registerBranchToolWithMCP(
  mcpServer: McpServer,
  tool: FinalizedBranchTool<string, any, any, any, any>
): void {
  console.error(`[registerBranchToolWithMCP] Registering tool: ${tool.name}`)
  
  // Get the shape from the Zod schema for MCP's input
  const zodSchema = tool.parameters
  let inputSchema: any = undefined

  if (zodSchema instanceof z.ZodObject) {
    const shape = (zodSchema as any).shape || (zodSchema as any)._def?.shape?.()
    if (shape) {
      inputSchema = shape
    }
  }

  console.error(`[registerBranchToolWithMCP] Input schema keys:`, inputSchema ? Object.keys(inputSchema) : 'undefined')

  try {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
      },
      async (args: any) => {
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const signal = new AbortController().signal

      const serverCtx: BranchServerContext = { callId, signal }

      try {
        let result: any

        if (tool.handoffConfig) {
          // Execute handoff pattern with branch context
          const { before, client: clientFn, after } = tool.handoffConfig

          // Phase 1: before()
          const beforeGen = before(args, serverCtx)
          const handoff = await executeGenerator(
            beforeGen[Symbol.iterator](),
            mcpServer.server
          )

          // Client phase with branch context
          // We need to create a BranchContext here
          const branchClientCtx = createBranchContextForMCP(mcpServer.server)
          const clientGen = clientFn(handoff, branchClientCtx)
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
          // Simple execute with branch context
          const branchClientCtx = createBranchContextForMCP(mcpServer.server)
          const execGen = tool.execute(args, branchClientCtx)
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
    console.error(`[registerBranchToolWithMCP] Successfully registered: ${tool.name}`)
  } catch (err) {
    console.error(`[registerBranchToolWithMCP] FAILED to register ${tool.name}:`, err)
  }
}

/**
 * Create a BranchContext for use with the MCP server.
 * This is a simplified version that yields protocol actions.
 */
function createBranchContextForMCP(server: Server): any {
  // Internal state for tracking messages
  const messages: Message[] = []

  const ctx = {
    // Read-only parent context (empty for top-level)
    parentMessages: [] as readonly Message[],
    parentSystemPrompt: undefined as string | undefined,

    // Current branch state
    get messages() {
      return messages as readonly Message[]
    },
    depth: 0,

    // Sample with both modes
    sample(config: any): { [Symbol.iterator](): Generator<any, SampleResult> } {
      return {
        *[Symbol.iterator](): Generator<any, SampleResult> {
          let messagesToSend: Message[]

          if ('prompt' in config && config.prompt) {
            // Auto-tracked mode
            const userMessage: Message = { role: 'user', content: config.prompt }
            messagesToSend = [...messages, userMessage]
          } else if ('messages' in config && config.messages) {
            // Explicit mode
            messagesToSend = config.messages
          } else {
            throw new Error('sample() requires either prompt or messages')
          }

          const result: any = yield {
            type: 'sample',
            params: {
              messages: messagesToSend.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: { type: 'text' as const, text: m.content },
              })),
              systemPrompt: config.systemPrompt,
              maxTokens: config.maxTokens ?? 1000,
            },
          }

          const text = result?.content?.text ?? result?.content ?? ''

          // If auto-tracked mode, update messages
          if ('prompt' in config && config.prompt) {
            messages.push(
              { role: 'user', content: config.prompt },
              { role: 'assistant', content: text }
            )
          }

          return {
            text,
            model: result?.model,
            stopReason: result?.stopReason,
          }
        },
      }
    },

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
            return { action: 'accept', content: result.content as T }
          } else if (result.action === 'decline') {
            return { action: 'decline' }
          } else {
            return { action: 'cancel' }
          }
        },
      }
    },

    branch<T>(
      fn: (ctx: any) => { [Symbol.iterator](): Iterator<any, T> },
      options: any = {}
    ): { [Symbol.iterator](): Generator<any, T> } {
      return {
        *[Symbol.iterator](): Generator<any, T> {
          // Create sub-context
          const inheritMessages = options.inheritMessages ?? true
          const subMessages: Message[] = inheritMessages ? [...messages] : []
          if (options.messages) {
            subMessages.push(...options.messages)
          }

          // Create sub-context with updated state
          const subCtx = createBranchContextForMCP(server)
          ;(subCtx as any).parentMessages = [...messages]
          ;(subCtx as any).parentSystemPrompt = options.systemPrompt
          ;(subCtx as any).depth = ctx.depth + 1

          // Copy inherited messages to sub-context
          for (const msg of subMessages) {
            ;(subCtx as any).messages.push(msg)
          }

          // Execute sub-branch
          const subGen = fn(subCtx)
          const subIterator = subGen[Symbol.iterator]()

          // Drive the sub-generator, passing through yields
          let subResult = subIterator.next()
          while (!subResult.done) {
            const response = yield subResult.value
            subResult = subIterator.next(response)
          }

          return subResult.value
        },
      }
    },

    log(level: LogLevel, message: string): { [Symbol.iterator](): Generator<any, void> } {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          yield { type: 'log', params: { level, message } }
        },
      }
    },

    notify(message: string, progress?: number): { [Symbol.iterator](): Generator<any, void> } {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          yield { type: 'notify', params: { message, progress } }
        },
      }
    },
  }

  return ctx
}
