/**
 * lib/chat/session/create-session.ts
 *
 * The chat session runtime - a long-lived Effection operation that
 * orchestrates the chat lifecycle with structured concurrency.
 *
 * This module is framework-agnostic. It uses pure Effection primitives
 * and can be used with React, Vue, Svelte, or any other UI framework.
 *
 * ## How the Command Loop Works
 *
 * ```typescript
 * for (const cmd of yield* each(commands)) {
 *   // handle command
 *   yield* each.next()
 * }
 * ```
 *
 * This looks like an infinite loop, but it's NOT busy-looping:
 *
 * 1. `each(commands)` returns an iterator over the signal
 * 2. When we hit `yield*`, we SUSPEND until a command arrives
 * 3. The Effection runtime parks this generator (0 CPU)
 * 4. When the UI calls `signal.send({type: 'send', ...})`, we wake up
 * 5. Process the command, then loop back and suspend again
 *
 * The loop only "runs" when there's work to do. Between commands,
 * this operation is completely idle.
 *
 * ## Structured Concurrency
 *
 * When we spawn a streaming request:
 * ```typescript
 * currentRequestTask = yield* spawn(function* () { ... })
 * ```
 *
 * If a new command arrives before streaming finishes:
 * ```typescript
 * yield* currentRequestTask.halt()  // Cancel the in-flight request
 * ```
 *
 * This automatically cleans up the fetch, closes connections, runs
 * finally blocks, etc. No manual cleanup needed.
 *
 * ## Transform Pipeline
 *
 * Patches flow through a transform pipeline before reaching the UI:
 * ```
 * streamChatOnce → [transform1] → [transform2] → patches → UI
 * ```
 *
 * The pipeline uses buffered channels internally, so messages are
 * never dropped regardless of subscription timing.
 *
 * ## Client Tool Orchestration
 *
 * Client-only tools are exposed to the LLM as client-authority isomorphic tools.
 * When the LLM requests them, the server emits `isomorphic_handoff` events.
 * The session then:
 * 1. Executes the tool client parts (with approval flow)
 * 2. Re-initiates the request with tool results
 * 3. Continues until the LLM is done
 */
import type { Operation, Task, Channel, Signal, Stream } from 'effection'
import { spawn, each, createChannel, createSignal, resource, useScope } from 'effection'
import { streamChatOnce, toApiMessages } from './stream-chat'
import { useTransformPipeline } from './transforms'
import { chatReducer, initialChatState } from '../state/reducer'
import type { ChatState } from '../state/chat-state'
import { StreamerContext, ToolRegistryContext, BaseUrlContext } from './contexts'
import type { ChatPatch } from '../patches'
import type { Message } from '../types'
import type { ChatCommand, SessionOptions, Streamer } from './options'
import type { StreamResult, ApiMessage } from './streaming'
import type { ApprovalSignalValue } from '../isomorphic-tools/runtime/tool-runtime'
import type { ToolHandlerRegistry, PendingUIRequest, AnyIsomorphicTool } from '../isomorphic-tools'
import type { PendingEmission } from '../isomorphic-tools/runtime/emissions'

import {
  executeIsomorphicToolsClient,
  executeIsomorphicToolsClientWithReactHandlers,
  formatIsomorphicToolResult,
  createUIRequestChannel,
  createIsomorphicToolRegistry,
} from '../isomorphic-tools'

/** Default streamer - uses fetch to call the chat API */
const defaultStreamer: Streamer = streamChatOnce

/**
 * Value sent through the handoff response signal from UI handlers.
 */
export interface HandoffResponseSignalValue {
  callId: string
  output: unknown
}

/**
 * Extended session options with isomorphic tool support.
 */
export interface ClientToolSessionOptions extends SessionOptions {
  /**
   * Signal for receiving approval/denial from UI.
   */
  approvalSignal?: Signal<ApprovalSignalValue, void>

  /**
   * Registry of UI tool handlers.
   *
   * When a tool has a handler registered here, instead of running its
   * `*client()` generator, the session emits a `pending_handoff` patch
   * and waits for `handoffResponseSignal` to receive the response.
   */
  reactHandlers?: ToolHandlerRegistry

  /**
   * Signal for receiving responses from UI tool handlers.
   */
  handoffResponseSignal?: Signal<HandoffResponseSignalValue, void>

  /**
   * Channel for UI requests from tools using ctx.waitFor().
   * 
   * When tools call `yield* ctx.waitFor('type', payload)`, the request
   * is sent through this channel for the platform layer to handle.
   * 
   * If not provided, the session will create one internally.
   */
  uiRequestChannel?: Channel<PendingUIRequest, void>
}


export interface ChatSession {
  state: Stream<ChatState, void>
  dispatch: (command: ChatCommand) => void
}

/**
 * Create a chat session resource.
 *
 * This resource orchestrates the entire chat lifecycle:
 * 1. Creates internal signals/channels for commands and patches
 * 2. Spawns the runChatSession loop to process commands -> patches
 * 3. Spawns a state reducer loop to process patches -> state
 * 4. Exposes a simple { state, dispatch } API
 */
export function createChatSession(options: ClientToolSessionOptions = {}): Operation<ChatSession> {
  return resource(function* (provide) {
    const scope = yield* useScope()
    const commands = createSignal<ChatCommand, void>()
    const patches = createChannel<ChatPatch, void>()
    const stateSignal = createSignal<ChatState, void>()

    // Build tool registry from provided tools
    const toolsRegistry = options.tools?.length
      ? createIsomorphicToolRegistry(options.tools as AnyIsomorphicTool[])
      : undefined

    // Provide contexts from options (if specified)
    // This allows callers to configure via options OR via parent context
    if (options.baseUrl) {
      yield* BaseUrlContext.set(options.baseUrl)
    }
    if (options.streamer) {
      yield* StreamerContext.set(options.streamer)
    }
    if (toolsRegistry) {
      yield* ToolRegistryContext.set(toolsRegistry)
    }

    // Spawn the core session logic (commands -> patches)
    yield* spawn(() => runChatSession(commands, patches, options))

    // Spawn the state reducer loop (patches -> state)
    yield* spawn(function* () {
      let currentState = initialChatState
      // Emit initial state
      stateSignal.send(currentState)
      
      for (const patch of yield* each(patches)) {
        currentState = chatReducer(currentState, patch)
        stateSignal.send(currentState)
        yield* each.next()
      }
    })

    // Provide the public API
    yield* provide({
      state: stateSignal,
      dispatch: (cmd) => scope.run(function* () { 
        commands.send(cmd)
        return undefined
      }),
    })
  })
}

/**
 * Run the chat session.
 *
 * Consumes commands from the signal, emits patches to the channel.
 * Owns the message history and current streaming state.
 *
 * @param commands - Signal for incoming commands from UI
 * @param patches - Channel to emit state patches to UI
 * @param options - Optional session configuration
 */
export function* runChatSession(
  commands: Signal<ChatCommand, void>,
  patches: Channel<ChatPatch, void>,
  options: ClientToolSessionOptions = {}
): Operation<void> {
  // Session state (owned by this operation)
  const history: Message[] = []
  let currentRequestTask: Task<StreamResult> | null = null
  
  // Track disabled tools (from denial with 'disable' behavior)
  const disabledToolNames = new Set<string>()

  // Create approval signal if not provided (for client tools)
  const approvalSignal = options.approvalSignal ?? createSignal<ApprovalSignalValue, void>()

  // Command loop - SUSPENDS here waiting for next command (0 CPU while waiting)
  // See file header for detailed explanation of how this works.
  for (const cmd of yield* each(commands)) {
    switch (cmd.type) {
      case 'send': {
        // Cancel any in-flight request
        if (currentRequestTask) {
          yield* currentRequestTask.halt()
          currentRequestTask = null
        }

        // Create user message
        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content: cmd.content,
        }

        // Render user message if renderer provided
        const rendered = options.renderer?.(cmd.content)

        // Add to history immediately
        history.push(userMessage)
        yield* patches.send({
          type: 'user_message',
          message: userMessage,
          ...(rendered !== undefined && { rendered }),
        })

        // Start streaming
        yield* patches.send({ type: 'streaming_start' })

        // Spawn the streaming request as a child task
        // This lets us cancel it if a new command arrives
        currentRequestTask = yield* spawn(function* () {
          try {
             // Create transform pipeline (handles empty transforms with passthrough)
             // The resource pattern ensures transforms are subscribed before we start writing
             const streamPatches = yield* useTransformPipeline(
               patches,
               options.transforms ?? []
             )

            // Get isomorphic tools registry from context (set from options.tools above)
            const isomorphicToolsRegistry = yield* ToolRegistryContext.get()

            // Build isomorphic tool schemas (excluding disabled tools)
            const isomorphicToolSchemas = isomorphicToolsRegistry
              ? isomorphicToolsRegistry.toToolSchemas().filter(
                  (schema: { name: string }) => !disabledToolNames.has(schema.name)
                )
              : undefined

            // Get streamer from context or options, fallback to default
            const contextStreamer = yield* StreamerContext.get()
            const streamer = contextStreamer ?? options.streamer ?? defaultStreamer
            
            // Run the chat loop - may loop if client tools need execution
            let result: StreamResult
            let currentMessages: ApiMessage[] = toApiMessages(history)
            
            // Client outputs from isomorphic tools that need server phase 2
            // Populated for:
            // - Client-authority tools: server validates client output
            // - V7 handoff tools: server runs after() with cached handoff + client output
            let isomorphicClientOutputs: Array<{
              callId: string
              toolName: string
              params: unknown
              clientOutput: unknown
              /** For V7 handoff: cached data from before() */
              cachedHandoff?: unknown
              /** For V7 handoff: indicates phase 2 is needed */
              usesHandoff?: boolean
            }> = []
            
            // eslint-disable-next-line no-constant-condition
            while (true) {
              result = yield* streamer(
                currentMessages,
                streamPatches,
                {
                  ...options,
                  isomorphicToolSchemas,
                  isomorphicClientOutputs: isomorphicClientOutputs.length > 0 ? isomorphicClientOutputs : undefined,
                } as any // Type cast needed for extended options
              )
              
              // Clear client outputs after sending (they've been processed)
              isomorphicClientOutputs = []
              
              // If complete, we're done
              if (result.type === 'complete') {
                break
              }
              
              // Isomorphic handoff - execute client parts
              if (result.type === 'isomorphic_handoff' && isomorphicToolsRegistry) {
                // Build handoff data for each isomorphic tool
                const handoffsWithTools = result.handoffs.map((handoff) => {
                  const tool = isomorphicToolsRegistry.get(handoff.toolName)
                  if (!tool) {
                    throw new Error(`Isomorphic tool not found: ${handoff.toolName}`)
                  }
                  return { tool, handoff }
                })
                
                // Execute all client parts concurrently
                // Use React handler mode if handlers are registered
                // Create UI request channel for waitFor() support if not provided
                const uiRequestChannel = options.uiRequestChannel ?? createUIRequestChannel()
                
                // Create emission channel for ctx.render() support
                // Always create it - tools that don't use it simply won't emit
                const emissionChannel = createChannel<PendingEmission, void>()
                
                // Spawn a task to forward emissions to patches
                yield* spawn(function* () {
                  // Capture scope to run operations from sync callbacks
                  const scope = yield* useScope()
                  
                  for (const pendingEmission of yield* each(emissionChannel)) {
                    const { emission, respond } = pendingEmission
                    // Extract callId from emission id (format: "callId-em-N")
                    const callId = emission.id.split('-em-')[0] as string
                    
                    // Wrap the respond callback to also emit a state update patch
                    const wrappedRespond = (response: unknown) => {
                      // Use scope.run to execute the patch send from sync callback
                      scope.run(function* () {
                        yield* patches.send({
                          type: 'tool_emission_response',
                          callId,
                          emissionId: emission.id,
                          response,
                        })
                      })
                      
                      // Then, call the original respond to resume the generator
                      respond(response)
                    }
                    
                    // Emit the emission patch with wrapped respond
                    yield* patches.send({
                      type: 'tool_emission',
                      callId,
                      emission: {
                        id: emission.id,
                        type: emission.type,
                        payload: emission.payload,
                        status: emission.status,
                        timestamp: emission.timestamp,
                      },
                      respond: wrappedRespond,
                    } as ChatPatch)
                    yield* each.next()
                  }
                })
                
                const isomorphicResults = options.reactHandlers && options.handoffResponseSignal
                  ? yield* executeIsomorphicToolsClientWithReactHandlers({
                      handoffs: handoffsWithTools,
                      patches,
                      approvalSignal,
                      reactHandlers: options.reactHandlers,
                      handoffResponseSignal: options.handoffResponseSignal,
                      uiRequestChannel,
                      emissionChannel,
                    })
                  : yield* executeIsomorphicToolsClient(
                      handoffsWithTools,
                      patches,
                      approvalSignal,
                      uiRequestChannel,
                      emissionChannel
                    )
                
                // Build messages for re-initiation
                const conversationMessages: ApiMessage[] = result.conversationState.messages.map(msg => ({
                  role: msg.role,
                  content: msg.content,
                  tool_calls: (msg as any).tool_calls,
                  tool_call_id: (msg as any).tool_call_id,
                }))
                
                // Add assistant message with tool_calls
                const allToolCalls = result.conversationState.toolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                }))
                
                conversationMessages.push({
                  role: 'assistant',
                  content: result.conversationState.assistantContent || '',
                  tool_calls: allToolCalls,
                })
                
                // Add server tool results
                for (const serverResult of result.conversationState.serverToolResults) {
                  conversationMessages.push({
                    role: 'tool',
                    tool_call_id: serverResult.id,
                    content: serverResult.content,
                  })
                }
                
                // Add isomorphic tool results (merged server + client outputs)
                // Collect outputs for server phase 2 when needed:
                // - Client-authority tools: server validates client output
                // - V7 handoff tools: server runs after() with cached handoff + client output
                 for (let i = 0; i < isomorphicResults.length; i++) {
                   const isoResult = isomorphicResults[i]!
                   const handoff = result.handoffs[i]!
                  
                   // Determine if we need server phase 2
                  const needsPhase2 = handoff.authority === 'client' || handoff.usesHandoff === true
                  
                  if (needsPhase2) {
                    // For phase 2 tools, DON'T add the tool message here.
                    // The server will add the proper result after running *after().
                    // We just need to send the client output for the server to process.
                    if (isoResult.ok && isoResult.clientOutput !== undefined) {
                      isomorphicClientOutputs.push({
                        callId: isoResult.callId,
                        toolName: isoResult.toolName,
                        params: handoff.params,
                        clientOutput: isoResult.clientOutput,
                        // For V7 handoff: pass the cached handoff data (serverOutput from phase 1)
                        cachedHandoff: handoff.usesHandoff ? handoff.serverOutput : undefined,
                        usesHandoff: handoff.usesHandoff ?? false,
                      })
                    }
                  } else {
                    // For non-phase-2 tools (server authority without handoff),
                    // the result is already final - add the tool message
                    conversationMessages.push(formatIsomorphicToolResult(isoResult))
                  }
                }
                // Update current messages for re-initiation
                currentMessages = conversationMessages
                continue
              }
              
              // Unknown result type - shouldn't happen
              break
            }

            // Send streaming_end THROUGH the transform to trigger final settle
            // This ensures all pending content is flushed before we finalize
            yield* streamPatches.send({ type: 'streaming_end' })
            
            // Close the input channel (transform will finish processing)
            yield* streamPatches.close()

            // Sync history with currentMessages which accumulated during the loop
            // currentMessages contains the full conversation including:
            // - Original user message
            // - Assistant messages with tool_calls (from isomorphic handoffs)
            // - Tool result messages (may have empty content if phase 2)
            // - The final response will be added below
            
            // Get tool results from the complete result (these have the actual content
            // from phase 2 processing that the server did)
            const completeResult = result as { 
              type: 'complete'
              text: string
              toolResults?: Array<{ id: string; name: string; content: string }>
            }
            
            // Build a map of tool results for quick lookup
            const toolResultsMap = new Map<string, string>()
            if (completeResult.toolResults) {
              for (const tr of completeResult.toolResults) {
                toolResultsMap.set(tr.id, tr.content)
              }
            }
            
            // Find new messages that need to be added to history
            const originalHistoryLength = history.length
            
            // Add any new messages from currentMessages
            for (let i = originalHistoryLength; i < currentMessages.length; i++) {
              const apiMsg = currentMessages[i]!
              
              // For tool results, check if we have updated content from phase 2
              let content = apiMsg.content
              if (apiMsg.role === 'tool' && apiMsg.tool_call_id) {
                const updatedContent = toolResultsMap.get(apiMsg.tool_call_id)
                if (updatedContent) {
                  content = updatedContent
                }
              }
              
              const msg: Message = {
                id: crypto.randomUUID(),
                role: apiMsg.role,
                content: content,
              }
              
              // Preserve tool_calls with proper type field
              if (apiMsg.tool_calls && apiMsg.tool_calls.length > 0) {
                msg.tool_calls = apiMsg.tool_calls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: 'function' in tc ? tc.function : { name: (tc as any).name, arguments: (tc as any).arguments },
                }))
              }
              
              // Preserve tool_call_id
              if (apiMsg.tool_call_id) {
                msg.tool_call_id = apiMsg.tool_call_id
              }
              
              history.push(msg)
            }

            // Create final assistant message with the response text
            const finalContent = completeResult.text || ''
            const assistantMessage: Message = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: finalContent,
            }
            history.push(assistantMessage)
            
            // Assistant message goes directly to patches (not through transforms)
            // because it's a finalization signal, not streaming content.
            // At this point the transform has already flushed via streaming_end.
            yield* patches.send({
              type: 'assistant_message',
              message: assistantMessage,
            })

            return result
          } catch (error) {
            // Only emit error if not halted
            const message =
              error instanceof Error ? error.message : 'Unknown error'
            yield* patches.send({ type: 'error', message })
            throw error
          } finally {
            yield* patches.send({ type: 'streaming_end' })
            currentRequestTask = null
          }
        })

        break
      }

      case 'abort': {
        // Cancel in-flight request
        if (currentRequestTask) {
          yield* currentRequestTask.halt()
          currentRequestTask = null
        }
        
        // Check if we should preserve partial content
        const preservePartial = options.preservePartialOnAbort ?? true
        const suffix = options.abortSuffix ?? ''
        
        if (preservePartial && cmd.partialContent?.trim()) {
          // Build the partial message with optional suffix
          const contentWithSuffix = cmd.partialContent + suffix
          const partialMessage: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: contentWithSuffix,
            partial: true,
          }
          
          // Add to history for future LLM context
          history.push(partialMessage)
          
          // Send to UI with rendered HTML
           yield* patches.send({
             type: 'abort_complete',
             message: partialMessage,
             ...(cmd.partialHtml !== undefined && { rendered: cmd.partialHtml }),
           })
        } else {
          // No content to preserve, just end streaming
          yield* patches.send({ type: 'streaming_end' })
        }
        break
      }

      case 'reset': {
        // Cancel in-flight request
        if (currentRequestTask) {
          yield* currentRequestTask.halt()
          currentRequestTask = null
        }
        // Clear history and disabled tools
        history.length = 0
        disabledToolNames.clear()
        yield* patches.send({ type: 'reset' })
        break
      }
    }

    yield* each.next()
  }
}

/**
 * Create the channels/signals needed for a chat session.
 * Returns a resource that sets up the session runtime.
 */
export function createChatSessionChannels() {
  return createChannel<ChatPatch, void>()
}
