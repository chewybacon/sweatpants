/**
 * MCP Bridge Runtime
 *
 * Bridges generator-authored MCP tools (Effection Operations)
 * to the official @modelcontextprotocol/sdk server.
 *
 * Key design choice:
 * - Tools are authored as Effection Operations (generator functions)
 * - We execute them using Effection's `run()`
 * - Sampling/elicitation/logging/progress are implemented as real MCP SDK calls
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { call, run } from 'effection'
import type { Operation } from 'effection'
import { z } from 'zod'
import type {
  BranchMCPClient,
  BranchServerContext,
  ElicitConfig,
  ElicitResult,
  FinalizedBranchTool,
  FinalizedMCPTool,
  LogLevel,
  MCPClientContext,
  MCPServerContext,
  Message,
  SampleConfig,
  SampleResult,
} from '@sweatpants/framework/chat/mcp-tools'
import { MCPCapabilityError, runBranchTool } from '@sweatpants/framework/chat/mcp-tools'

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
// JSON SCHEMA HELPERS (for elicitation)
// =============================================================================

/**
 * Convert Zod schema to JSON Schema.
 *
 * We keep this local to avoid coupling yo-mcp to a specific zod-json-schema package.
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
// MCP CLIENT ADAPTERS (Effection operations calling MCP SDK)
// =============================================================================

function createSDKMCPClientContext(options: {
  server: Server
  callId: string
  signal: AbortSignal
}): MCPClientContext {
  const { server, callId, signal } = options

  return {
    elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>> {
      return {
        *[Symbol.iterator](): Generator<any, ElicitResult<T>> {
          const jsonSchema = zodToJsonSchema(config.schema)

          const result = yield* call(() =>
            server.elicitInput(
              {
                message: config.message,
                requestedSchema: jsonSchema as any,
              },
              { signal }
            )
          )

          if (result.action === 'accept') {
            return { action: 'accept', content: result.content as T }
          }
          if (result.action === 'decline') {
            return { action: 'decline' }
          }
          return { action: 'cancel' }
        },
      }
    },

    sample<T = string>(config: SampleConfig<T>): Operation<T> {
      return {
        *[Symbol.iterator](): Generator<any, T> {
          const result: any = yield* call(() =>
            server.createMessage(
              {
                messages: [
                  {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: config.prompt },
                  },
                ],
                ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
                maxTokens: config.maxTokens ?? 1000,
                ...(config.modelPreferences !== undefined
                  ? { modelPreferences: config.modelPreferences }
                  : {}),
              },
              { signal }
            )
          )

          const text: string = result?.content?.text ?? result?.content ?? ''

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

    log(level: LogLevel, message: string): Operation<void> {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          try {
            yield* call(() =>
              server.sendLoggingMessage({
                level,
                data: message,
              })
            )
          } catch {
            // ignore
          }
        },
      }
    },

    notify(message: string, progress?: number): Operation<void> {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          // Prefer the MCP-native progress notification, but we don't have the
          // request's progress token in this high-level handler.
          //
          // Using callId as a stable token is "best effort"; clients that didn't
          // request progress updates may ignore it.
          if (progress !== undefined) {
            try {
              yield* call(() =>
                server.notification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: callId,
                    progress,
                    total: 1,
                    message,
                  },
                })
              )
              return
            } catch {
              // Fall back to logging
            }
          }

          try {
            yield* call(() =>
              server.sendLoggingMessage({
                level: 'info',
                data: message,
              })
            )
          } catch {
            // ignore
          }
        },
      }
    },
  }
}

function createSDKBranchMCPClient(options: {
  server: Server
  callId: string
  signal: AbortSignal
}): BranchMCPClient {
  const { server, callId, signal } = options

  const clientCapabilities = server.getClientCapabilities()

  return {
    capabilities: {
      elicitation: Boolean(clientCapabilities?.elicitation),
      sampling: Boolean(clientCapabilities?.sampling),
    },

    sample(
      messages: Message[],
      requestOptions?: {
        systemPrompt?: string
        maxTokens?: number
      }
    ): Operation<SampleResult> {
      return {
        *[Symbol.iterator](): Generator<any, SampleResult> {
          if (!clientCapabilities?.sampling) {
            throw new MCPCapabilityError('sampling', 'Client does not support sampling')
          }

          const result: any = yield* call(() =>
            server.createMessage(
              {
                messages: messages
                  // Keep the wire format MCP-native: system prompt stays out-of-band.
                  .filter((m) => m.role !== 'system')
                  .map((m) => ({
                    role: m.role as 'user' | 'assistant',
                    content: { type: 'text' as const, text: m.content },
                  })),
                ...(requestOptions?.systemPrompt !== undefined
                  ? { systemPrompt: requestOptions.systemPrompt }
                  : {}),
                maxTokens: requestOptions?.maxTokens ?? 1000,
              },
              { signal }
            )
          )

          const text: string = result?.content?.text ?? result?.content ?? ''

          return {
            text,
            model: result?.model,
            stopReason: result?.stopReason,
          }
        },
      }
    },

    elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>> {
      return {
        *[Symbol.iterator](): Generator<any, ElicitResult<T>> {
          if (!clientCapabilities?.elicitation) {
            throw new MCPCapabilityError('elicitation', 'Client does not support elicitation')
          }

          const jsonSchema = zodToJsonSchema(config.schema)
          const result = yield* call(() =>
            server.elicitInput(
              {
                message: config.message,
                requestedSchema: jsonSchema as any,
              },
              { signal }
            )
          )

          if (result.action === 'accept') {
            return { action: 'accept', content: result.content as T }
          }
          if (result.action === 'decline') {
            return { action: 'decline' }
          }
          return { action: 'cancel' }
        },
      }
    },

    log(level: LogLevel, message: string): Operation<void> {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          try {
            yield* call(() => server.sendLoggingMessage({ level, data: message }))
          } catch {
            // ignore
          }
        },
      }
    },

    notify(message: string, progress?: number): Operation<void> {
      return {
        *[Symbol.iterator](): Generator<any, void> {
          if (progress !== undefined) {
            try {
              yield* call(() =>
                server.notification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: callId,
                    progress,
                    total: 1,
                    message,
                  },
                })
              )
              return
            } catch {
              // ignore and fall back to logging
            }
          }

          try {
            yield* call(() => server.sendLoggingMessage({ level: 'info', data: message }))
          } catch {
            // ignore
          }
        },
      }
    },
  }
}

function assertToolRequirements(
  server: Server,
  requires: { elicitation?: boolean; sampling?: boolean } | undefined
): void {
  if (!requires) return

  const caps = server.getClientCapabilities()

  if (requires.sampling && !caps?.sampling) {
    throw new MCPCapabilityError('sampling', 'Client does not support sampling')
  }

  if (requires.elicitation && !caps?.elicitation) {
    throw new MCPCapabilityError('elicitation', 'Client does not support elicitation')
  }
}

// =============================================================================
// MCP SERVER FACTORY
// =============================================================================

export interface CreateMCPServerOptions extends MCPBridgeOptions {
  /** Original MCP tools (using MCPClientContext) */
  tools?: FinalizedMCPTool<string, any, any, any, any>[]
  /** Branch-based tools (using BranchContext) */
  branchTools?: FinalizedBranchTool<string, any, any, any, any>[]
}

export function createMCPServerWithTools(
  options: MCPBridgeOptions,
  tools: FinalizedMCPTool<string, any, any, any, any>[]
): McpServer {
  return createMCPServer({
    ...options,
    tools,
  })
}

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

  for (const tool of options.tools ?? []) {
    registerToolWithMCP(mcpServer, tool)
  }

  for (const tool of options.branchTools ?? []) {
    registerBranchToolWithMCP(mcpServer, tool)
  }

  return mcpServer
}

// =============================================================================
// ORIGINAL TOOL SUPPORT (MCPClientContext)
// =============================================================================

function registerToolWithMCP(
  mcpServer: McpServer,
  tool: FinalizedMCPTool<string, any, any, any, any>
): void {
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
      const abortController = new AbortController()
      const signal = abortController.signal

      const serverCtx: MCPServerContext = { callId, signal }
      const clientCtx = createSDKMCPClientContext({
        server: mcpServer.server,
        callId,
        signal,
      })

      try {
        const result = await run(function* () {
          assertToolRequirements(mcpServer.server, tool.requires)

          if (tool.handoffConfig) {
            const { before, client: clientFn, after } = tool.handoffConfig
            const handoff = yield* before(args, serverCtx)
            const clientResult = yield* clientFn(handoff, clientCtx)
            return yield* after(handoff, clientResult, serverCtx, args)
          }

          if (tool.execute) {
            return yield* tool.execute(args, clientCtx)
          }

          throw new Error(`Tool \"${tool.name}\" has no execute or handoff config`)
        })

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
// BRANCH TOOL SUPPORT (BranchContext + runBranchTool)
// =============================================================================

function registerBranchToolWithMCP(
  mcpServer: McpServer,
  tool: FinalizedBranchTool<string, any, any, any, any>
): void {
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
      const abortController = new AbortController()
      const signal = abortController.signal

      const serverCtx: BranchServerContext = { callId, signal }

      const branchClient = createSDKBranchMCPClient({
        server: mcpServer.server,
        callId,
        signal,
      })

      try {
        const result = await run(function* () {
          assertToolRequirements(mcpServer.server, tool.requires)

          // NOTE: Timeouts are intentionally not enforced yet.
          // This is the seam where we'd introduce tool-level timeouts.

          return yield* runBranchTool(tool as any, args, branchClient, {
            callId,
            signal,
          })
        })

        // Ensure serverCtx is used (future timeouts/cancellation hooks live here)
        void serverCtx

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
