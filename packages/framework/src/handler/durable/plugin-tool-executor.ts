/**
 * Plugin Tool Executor for Chat Engine
 *
 * Handles execution of MCP plugin tools within the chat engine.
 * When a tool call matches a registered plugin, this module:
 * 1. Creates a BridgeHost to run the tool
 * 2. Handles elicit events by dispatching to plugin handlers
 * 3. Handles sample events using the chat provider
 * 4. Emits stream events for tool results/errors
 *
 * @packageDocumentation
 */
import { spawn, each, type Operation, type Channel } from 'effection'
import type { ChatProvider } from '../../lib/chat/providers/types.ts'
import type { PluginRegistry } from '../../lib/chat/mcp-tools/plugin-registry.ts'
import type { PluginClientRegistration } from '../../lib/chat/mcp-tools/plugin.ts'
import type { ElicitsMap, ExtendedMessage } from '../../lib/chat/mcp-tools/mcp-tool-types.ts'
import type { FinalizedMcpToolWithElicits } from '../../lib/chat/mcp-tools/mcp-tool-builder.ts'
import {
  createBridgeHost,
  type BridgeEvent,
  type ElicitResponse,
  type SampleResponse,
} from '../../lib/chat/mcp-tools/bridge-runtime.ts'
import {
  createPluginClientContext,
  executePluginElicitHandlerFromRequest,
} from '../../lib/chat/mcp-tools/plugin-executor.ts'
import type {
  ComponentEmissionPayload,
  PendingEmission,
} from '../../lib/chat/isomorphic-tools/runtime/emissions.ts'
import type { StreamEvent } from '../types.ts'
import type { ToolCall, ToolExecutionResult } from './types.ts'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for plugin tool execution.
 */
export interface PluginToolExecutionConfig {
  /** The tool call from the LLM */
  toolCall: ToolCall

  /** The finalized MCP tool (with .elicits) */
  tool: FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

  /** The plugin client registration */
  plugin: PluginClientRegistration<ElicitsMap>

  /** Chat provider for handling sample events */
  provider: ChatProvider

  /** Emission channel for plugin UI rendering */
  emissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined

  /** Abort signal for cancellation */
  signal: AbortSignal
}

/**
 * Result of plugin tool execution.
 */
export type PluginToolResult =
  | { ok: true; callId: string; toolName: string; result: unknown }
  | { ok: false; callId: string; toolName: string; error: string }

// =============================================================================
// PLUGIN TOOL DETECTION
// =============================================================================

/**
 * Extract text content from a message for passing to chat provider.
 * Handles both simple string content and MCP content blocks.
 */
function getMessageTextContent(msg: ExtendedMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content
  }
  if (msg.content === null || msg.content === undefined) {
    return ''
  }
  // MCP content blocks
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]
  return blocks
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return JSON.stringify(block.input)
      if (block.type === 'tool_result') {
        const innerBlocks = Array.isArray(block.content) ? block.content : [block.content]
        return innerBlocks.map(b => b.type === 'text' ? b.text : '').join('')
      }
      return ''
    })
    .join('')
}

/**
 * Check if a tool is a plugin tool (has .elicits property).
 */
export function isPluginTool(
  tool: unknown
): tool is FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap> {
  return (
    tool != null &&
    typeof tool === 'object' &&
    'elicits' in tool &&
    tool.elicits != null &&
    typeof tool.elicits === 'object'
  )
}

/**
 * Get the plugin registration for a tool name, if it exists.
 */
export function getPluginForTool(
  toolName: string,
  pluginRegistry: PluginRegistry | undefined
): PluginClientRegistration<ElicitsMap> | undefined {
  if (!pluginRegistry) return undefined
  return pluginRegistry.get(toolName)
}

// =============================================================================
// PLUGIN TOOL EXECUTION
// =============================================================================

/**
 * Execute a plugin tool using the BridgeHost pattern.
 *
 * This function:
 * 1. Creates a BridgeHost for the tool
 * 2. Spawns an event handler to process bridge events
 * 3. Runs the tool to completion
 * 4. Returns the result
 */
export function* executePluginTool(
  config: PluginToolExecutionConfig
): Operation<PluginToolResult> {
  const { toolCall, tool, plugin, provider, emissionChannel, signal } = config
  const callId = toolCall.id
  const toolName = toolCall.function.name

  try {
    // Parse params
    const params = toolCall.function.arguments

    // Create the bridge host
    const host = createBridgeHost({
      tool,
      params,
      callId,
      signal,
    })

    // Spawn event handler to process bridge events
    yield* spawn(function* () {
      for (const event of yield* each(host.events)) {
        yield* handleBridgeEvent(event, plugin, provider, emissionChannel, callId, signal)
        yield* each.next()
      }
    })

    // Run the tool to completion
    const result = yield* host.run()

    return {
      ok: true,
      callId,
      toolName,
      result,
    }
  } catch (error) {
    return {
      ok: false,
      callId,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Handle a bridge event from the plugin tool.
 */
function* handleBridgeEvent(
  event: BridgeEvent,
  plugin: PluginClientRegistration<ElicitsMap>,
  provider: ChatProvider,
  emissionChannel: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined,
  callId: string,
  signal: AbortSignal
): Operation<void> {
  switch (event.type) {
    case 'elicit': {
      // Create plugin client context
      if (!emissionChannel) {
        // No emission channel - can't render UI
        // Decline the elicitation
        event.responseSignal.send({
          id: event.request.id,
          result: { action: 'decline' },
        })
        return
      }

      const ctx = createPluginClientContext({
        callId,
        toolName: plugin.toolName,
        elicitRequest: event.request,
        emissionChannel,
        signal,
      })

      try {
        // Execute the plugin's handler for this elicitation key
        const result = yield* executePluginElicitHandlerFromRequest(plugin, event.request, ctx)

        // Send the response back to the tool
        event.responseSignal.send({
          id: event.request.id,
          result,
        } as ElicitResponse)
      } catch (error) {
        // Handler failed - cancel the elicitation
        event.responseSignal.send({
          id: event.request.id,
          result: { action: 'cancel' },
        })
      }
      break
    }

    case 'sample': {
      // Use the chat provider to sample
      try {
        // Convert MCP messages to chat messages
        // Extract text content from messages (handles both string and MCP content blocks)
        const chatMessages = event.messages.map((msg: ExtendedMessage) => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: getMessageTextContent(msg),
        }))

        // Get the stream from provider
        const stream = provider.stream(chatMessages, undefined)
        const subscription = yield* stream

        // Collect all text from the stream
        let fullText = ''
        let iteration = yield* subscription.next()
        while (!iteration.done) {
          const chatEvent = iteration.value
          if (chatEvent.type === 'text') {
            fullText += chatEvent.content
          }
          iteration = yield* subscription.next()
        }

        // The final result has the complete text
        const chatResult = iteration.value
        const responseText = chatResult?.text ?? fullText

        // Send sample response
        event.responseSignal.send({
          result: { text: responseText },
        } as SampleResponse)
      } catch (error) {
        // Sampling failed
        event.responseSignal.send({
          result: { text: `[Sampling error: ${error instanceof Error ? error.message : String(error)}]` },
        } as SampleResponse)
      }
      break
    }

    case 'log': {
      // Logs are informational - could emit as stream events if needed
      // For now, just log to console in development
      if (process.env['NODE_ENV'] === 'development') {
        console.log(`[Plugin ${plugin.toolName}] ${event.level}: ${event.message}`)
      }
      break
    }

    case 'notify': {
      // Progress notifications - could emit as stream events if needed
      // For now, just log to console in development
      if (process.env['NODE_ENV'] === 'development') {
        const progress = event.progress !== undefined ? ` (${Math.round(event.progress * 100)}%)` : ''
        console.log(`[Plugin ${plugin.toolName}] Progress${progress}: ${event.message}`)
      }
      break
    }
  }
}

/**
 * Convert a plugin tool result to a ToolExecutionResult.
 */
export function pluginResultToToolResult(result: PluginToolResult): ToolExecutionResult {
  if (result.ok) {
    return {
      ok: true,
      kind: 'result',
      callId: result.callId,
      toolName: result.toolName,
      serverOutput: result.result,
    }
  }

  return {
    ok: false,
    error: {
      callId: result.callId,
      toolName: result.toolName,
      message: result.error,
    },
  }
}

/**
 * Convert a plugin tool result to a StreamEvent.
 */
export function pluginResultToStreamEvent(result: PluginToolResult): StreamEvent {
  if (result.ok) {
    const content =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result)

    return {
      type: 'tool_result',
      id: result.callId,
      name: result.toolName,
      content,
    }
  }

  return {
    type: 'tool_error',
    id: result.callId,
    name: result.toolName,
    message: result.error,
  }
}
