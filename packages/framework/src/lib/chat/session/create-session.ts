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
 * Client-only tools are exposed to the LLM as isomorphic tools.
 * When the LLM requests them, the server emits `isomorphic_handoff` events.
 * The session then:
 * 1. Executes the tool client parts (with approval flow)
 * 2. Re-initiates the request with tool results
 * 3. Continues until the LLM is done
 */
import {
  spawn,
  each,
  createChannel,
  createSignal,
  resource,
  useScope,
  call,
  type Operation,
  type Task,
  type Channel,
  type Signal,
  type Stream,
  type Subscription,
} from 'effection'
import { streamChatOnce, type ElicitResponseData } from './stream-chat.ts'
import { useTransformPipeline } from './transforms.ts'
import { chatReducer, initialChatState } from '../state/reducer.ts'
import type { ChatState } from '../state/chat-state.ts'
import { StreamerContext, ToolRegistryContext, BaseUrlContext } from './contexts.ts'
import type { ChatPatch } from '../patches/index.ts'
import type { Message } from '../types.ts'
import type { ChatCommand, SessionOptions, Streamer, PatchTransform } from './options.ts'
import type { ConversationReplayState, ConversationReplayToolTrace, StreamResult } from './streaming.ts'
import {
  syncConversationStateForElicit,
  syncConversationStateForComplete,
  syncMessagesFromIndex,
} from './turn-manager.ts'
import {
  appendAssistantFinalMessage,
  appendAssistantToolCallMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
  resetTranscriptState,
} from './transcript.ts'
import { readDurableHistory } from './durable-history.ts'
import type { ApprovalSignalValue } from '../isomorphic-tools/runtime/tool-runtime.ts'
import {
  executeIsomorphicToolsClient,
  executeIsomorphicToolsClientWithReactHandlers,
  formatIsomorphicToolResult,
  createUIRequestChannel,
  createIsomorphicToolRegistry,
  type ToolHandlerRegistry,
  type PendingUIRequest,
  type AnyIsomorphicTool,
} from '../isomorphic-tools/index.ts'
import type { PendingEmission } from '../isomorphic-tools/runtime/emissions.ts'

/** Default streamer - uses fetch to call the chat API */
const defaultStreamer: Streamer = streamChatOnce

function createBufferedStateSignal<T>() {
  const values: T[] = []
  const signal = createSignal<T, void>()

  return {
    send(value: T) {
      values.push(value)
      signal.send(value)
    },
    *subscribe(): Operation<Stream<T, void>> {
      const live: Subscription<T, void> = yield* signal
      let replayIndex = 0

      return resource(function* (provide) {
        yield* provide({
          *next(): Operation<IteratorResult<T, void>> {
            if (replayIndex < values.length) {
              return { done: false, value: values[replayIndex++]! }
            }

            return yield* live.next()
          },
        })
      })
    },
  }
}

/**
 * Value sent through the handoff response signal from UI handlers.
 */
export interface HandoffResponseSignalValue {
  callId: string
  output: unknown
}

type ReplayToolTrace = {
  callId: string
  toolName: string
  trace: ConversationReplayToolTrace['trace']
}

function collectReplayToolTraces(messages: Message[]): ReplayToolTrace[] {
  const traces: ReplayToolTrace[] = []

  for (const message of messages) {
    const replay = message.replay
    if (!replay?.trace || !message.tool_call_id) {
      continue
    }

    traces.push({
      callId: message.tool_call_id,
      toolName: replay.toolName ?? 'unknown',
      trace: replay.trace,
    })
  }

  return traces
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
    const stateSignal = createBufferedStateSignal<ChatState>()

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
      state: yield* stateSignal.subscribe(),
      dispatch: (cmd) => scope.run(function* () {
        yield* call(() => {
          commands.send(cmd)
          return undefined
        })
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
  const transcriptState = createTranscriptState(history)
  let currentRequestTask: Task<StreamResult> | null = null
  
  // Track disabled tools (from denial with 'disable' behavior)
  const disabledToolNames = new Set<string>()
  
  // Track pending plugin elicit responses (sent with next message)
  const pendingElicitResponses: ElicitResponseData[] = []
  const sentElicitResponseIds = new Set<string>()
  
  // Track pending tool_calls that are awaiting elicitation (need tool result messages if cancelled)
  // These are tool_calls from assistant messages that haven't received their tool result yet
  let pendingToolCalls: Array<{ id: string; name: string }> = []
  let replayState: ConversationReplayState | undefined

  // Create approval signal if not provided (for client tools)
  const approvalSignal = options.approvalSignal ?? createSignal<ApprovalSignalValue, void>()

    if (options.conversationId) {
      const contextBaseUrl = yield* BaseUrlContext.get()
      const baseUrl = options.baseUrl ?? contextBaseUrl ?? '/api/chat'
      const durableHistory = yield* readDurableHistory({
      baseUrl,
      conversationId: options.conversationId,
      ...((options.tools?.length ?? 0) > 0
        ? { tools: options.tools as AnyIsomorphicTool[] }
        : {}),
      ...((options.transforms?.length ?? 0) > 0
        ? { transforms: options.transforms }
        : {}),
      ...(options.onStreamEvent ? { onStreamEvent: options.onStreamEvent } : {}),
      })

      for (const message of durableHistory.history) {
        history.push(message)
      }

      resetTranscriptState(transcriptState, history)

    replayState = durableHistory.replayState

    for (const patch of durableHistory.patches) {
      yield* patches.send(patch)
    }
  }

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

        // CRITICAL: If we had pending tool_calls from an elicit state, we need to add
        // "cancelled" tool result messages so OpenAI doesn't complain about missing tool outputs.
        // This happens when the user sends a new message while a tool was waiting for elicitation.
        if (pendingToolCalls.length > 0) {
          for (const tc of pendingToolCalls) {
            appendToolMessage(
              history,
              transcriptState,
              tc.id,
              'Tool execution was cancelled by user sending a new message.',
            )
          }
          pendingToolCalls = []
        }

        // Create user message
        const userMessage = appendUserMessage(history, transcriptState, cmd.content)

        // Render user message if renderer provided
        const rendered = options.renderer?.(cmd.content)

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
          // Track whether we've already sent streaming_end to avoid duplicates
          let streamingEndSent = false

          try {
            let streamingEndForwarded = false
            let streamingEndForwardedResolve: (() => void) | null = null

            function waitForStreamingEndForwarded(): Promise<void> {
              if (streamingEndForwarded) {
                return Promise.resolve()
              }
              return new Promise<void>((resolve) => {
                streamingEndForwardedResolve = resolve
              })
            }

            // Final transform to acknowledge that streaming_end made it through the
            // entire transform chain and was forwarded to the reducer.
            const streamingEndAcknowledger: PatchTransform = function* (input, output) {
              for (const patch of yield* each(input)) {
                yield* output.send(patch)

                if (patch.type === 'streaming_end' && !streamingEndForwarded) {
                  streamingEndForwarded = true
                  streamingEndForwardedResolve?.()
                  streamingEndForwardedResolve = null
                }

                yield* each.next()
              }
            }

            const transforms = options.transforms ?? []

            // Create transform pipeline (handles empty transforms with passthrough).
            // The resource pattern ensures transforms are subscribed before we start writing.
            const streamPatches = yield* useTransformPipeline(patches, [
              ...transforms,
              streamingEndAcknowledger,
            ])

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
            let currentMessages: Message[] = [...history]
            
            // Track original history length to know what messages need syncing after the loop
            const originalHistoryLength = history.length
            
            // Client outputs from isomorphic tools that need server phase 2
            // Populated for V7 handoff tools: server runs after() with cached handoff + client output
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
            
            // Capture pending plugin elicit responses for this request
            let elicitResponsesToSend: ElicitResponseData[] = []
            
            // eslint-disable-next-line no-constant-condition
            while (true) {
              // Move pending responses to this request (only on first iteration or if new ones arrived)
              if (pendingElicitResponses.length > 0) {
                elicitResponsesToSend = [...pendingElicitResponses]
                pendingElicitResponses.length = 0
              }
              
              result = yield* streamer(
                currentMessages,
                streamPatches,
                {
                  ...options,
                  ...(isomorphicToolSchemas != null && { isomorphicToolSchemas }),
                  ...(isomorphicClientOutputs.length > 0 && { isomorphicClientOutputs }),
                  ...(elicitResponsesToSend.length > 0 && { elicitResponses: elicitResponsesToSend }),
                  ...(replayState ? { replayState } : {}),
                }
              )
              
              // Clear client outputs and plugin responses after sending (they've been processed)
              isomorphicClientOutputs = []
              elicitResponsesToSend = []
              
              // If complete, we're done
              if (result.type === 'complete') {
                if (result.conversationState && currentMessages.length === originalHistoryLength) {
                  syncConversationStateForComplete(history, result.conversationState)
                  resetTranscriptState(transcriptState, history)
                }
                break
              }
              
              // Elicitation - sync conversation state and break the loop
              if (result.type === 'elicit') {
                // CRITICAL: Sync conversation state to history so the next request
                // includes the assistant message with tool_calls. Without this,
                // the next request will send tool results to OpenAI without the
                // corresponding tool_calls, causing "No tool call found" errors.
                
                pendingToolCalls = syncConversationStateForElicit(
                  history,
                  result.conversationState
                )
                resetTranscriptState(transcriptState, history)

                const assistantElicitHostMessage = [...history].reverse().find(
                  (message) =>
                    message.role === 'assistant' &&
                    message.content === '' &&
                    !message.tool_calls?.length &&
                    typeof message.id === 'string' &&
                    message.id.startsWith('assistant:final:')
                )
                if (assistantElicitHostMessage) {
                  yield* patches.send({
                    type: 'assistant_message',
                    message: assistantElicitHostMessage,
                  })
                }
                
                // Patches have already been emitted by stream-chat.
                // React state now has the pending elicitations in pendingElicits.
                // The UI will render based on this state and collect user responses.
                // When user sends next message, we'll include elicitResponses.
                // For now, break the loop - the request is "complete" from session perspective.
                break
              }

              if (result.type === 'isomorphic_handoff' && !isomorphicToolsRegistry) {
                syncConversationStateForComplete(history, result.conversationState)
                resetTranscriptState(transcriptState, history)
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
                
                // IMPORTANT: Subscribe to channel BEFORE spawning tool execution
                // This ensures we don't miss emissions due to race conditions
                const emissionSubscription = yield* emissionChannel
                
                // Spawn a task to forward emissions to patches
                yield* spawn(function* () {
                  // Capture scope to run operations from sync callbacks
                  const scope = yield* useScope()
                  
                  let next = yield* emissionSubscription.next()
                  while (!next.done) {
                    const pendingEmission = next.value
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
                    next = yield* emissionSubscription.next()
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
                const conversationMessages: Message[] = [...result.conversationState.messages]
                const conversationTranscriptState = createTranscriptState(conversationMessages)
                
                // Add assistant message with tool_calls
                const allToolCalls = result.conversationState.toolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                }))
                
                appendAssistantToolCallMessage(
                  conversationMessages,
                  conversationTranscriptState,
                  allToolCalls,
                  result.conversationState.assistantContent || '',
                )
                
                // Add server tool results
                for (const serverResult of result.conversationState.serverToolResults) {
                  appendToolMessage(
                    conversationMessages,
                    conversationTranscriptState,
                    serverResult.id,
                    serverResult.content,
                  )
                }

                const replayToolTraces = [
                  ...collectReplayToolTraces(conversationMessages),
                  ...isomorphicResults.flatMap((isoResult) => {
                    if (!isoResult.ok || !isoResult.trace) {
                      return []
                    }
                    return [{
                      callId: isoResult.callId,
                      toolName: isoResult.toolName,
                      trace: isoResult.trace,
                    }]
                  }),
                ]
                
                // Add isomorphic tool results (merged server + client outputs)
                // Collect outputs for server phase 2 when needed:
                // - V7 handoff tools: server runs after() with cached handoff + client output
                 for (let i = 0; i < isomorphicResults.length; i++) {
                   const isoResult = isomorphicResults[i]!
                   const handoff = result.handoffs[i]!
                  
                   // Determine if we need server phase 2
                   const needsPhase2 = handoff.usesHandoff === true
                  
                  if (needsPhase2) {
                    // For phase 2 tools, DON'T add the tool message here.
                    // We include a placeholder tool message so the next request has a
                    // valid assistant tool_call -> tool result shape. The actual
                    // content is filled in from phase 2 server output before history sync.
                    if (isoResult.ok && isoResult.clientOutput !== undefined) {
                      appendToolMessage(
                        conversationMessages,
                        conversationTranscriptState,
                        isoResult.callId,
                        '',
                        isoResult.trace
                          ? {
                              toolName: isoResult.toolName,
                              trace: isoResult.trace,
                            }
                          : undefined,
                      )

                      isomorphicClientOutputs.push({
                        callId: isoResult.callId,
                        toolName: isoResult.toolName,
                        params: handoff.params,
                        clientOutput: isoResult.clientOutput,
                        ...(isoResult.trace && { trace: isoResult.trace }),
                        // For V7 handoff: pass the cached handoff data (serverOutput from phase 1)
                        cachedHandoff: handoff.usesHandoff ? handoff.serverOutput : undefined,
                        usesHandoff: handoff.usesHandoff ?? false,
                      })
                    }
                  } else {
                    // For non-phase-2 tools (server-first without handoff),
                    // the result is already final - add the tool message
                    conversationMessages.push(formatIsomorphicToolResult(isoResult))
                  }
                }
                // Update current messages for re-initiation
                result.conversationState.replay = {
                  toolTraces: replayToolTraces,
                }
                replayState = result.conversationState.replay
                currentMessages = conversationMessages
                continue
              }
              
              // Unknown result type - shouldn't happen
              break
            }

            // Tool calls completed - clear pending tracking
            pendingToolCalls = []
            
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
            
            syncMessagesFromIndex(
              history,
              currentMessages,
              originalHistoryLength,
              toolResultsMap
            )
            resetTranscriptState(transcriptState, history)

            // Create final assistant message with the response text
            const finalContent = completeResult.text || ''
            const assistantMessage = appendAssistantFinalMessage(history, transcriptState, finalContent)
            
            // IMPORTANT ORDER: assistant_message MUST come before streaming_end!
            // The reducer needs the message ID to save finalized parts to finalizedParts.
            // If streaming_end comes first, there's no message ID and parts are lost.
            //
            // The sequence is:
            // 1. assistant_message - adds message to state.messages (gives us messageId)
            // 2. streaming_end through transform - triggers part_end with frames
            // 3. streaming_end forwarded - saves parts to finalizedParts[messageId]
            yield* patches.send({
              type: 'assistant_message',
              message: assistantMessage,
            })

            // Send streaming_end THROUGH the transform to trigger final settle.
            // We must wait until the transform chain has finished processing it
            // (including async processors like Shiki) before returning, otherwise the
            // transform resource will be torn down mid-flush and streaming_end might
            // never reach the reducer.
            yield* streamPatches.send({ type: 'streaming_end' })
            streamingEndSent = true
            yield* call(waitForStreamingEndForwarded)

            // Now we can safely close the input channel.
            yield* streamPatches.close()

            return result
          } catch (error) {
            // Only emit error if not halted
            const message =
              error instanceof Error ? error.message : 'Unknown error'
            yield* patches.send({ type: 'error', message })
            // Send streaming_end on error (not sent in try block if we got here)
            yield* patches.send({ type: 'streaming_end' })
            streamingEndSent = true
            throw error
          } finally {
            // Send streaming_end if not already sent (e.g., when task is halted/aborted)
            if (!streamingEndSent) {
              yield* patches.send({ type: 'streaming_end' })
            }
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
        pendingElicitResponses.length = 0
        yield* patches.send({ type: 'reset' })
        break
      }

      case 'continue': {
        // Continue the conversation without adding a user message
        // This is used to resume after plugin elicitation responses
        
        // Cancel any in-flight request
        if (currentRequestTask) {
          yield* currentRequestTask.halt()
          currentRequestTask = null
        }
        
        // Start streaming without adding a user message
        yield* patches.send({ type: 'streaming_start' })
        
        // Spawn the continuation request
        currentRequestTask = yield* spawn(function* () {
          let streamingEndSent = false
          
          try {
            let streamingEndForwarded = false
            let streamingEndForwardedResolve: (() => void) | null = null
            
            function waitForStreamingEndForwarded(): Promise<void> {
              if (streamingEndForwarded) {
                return Promise.resolve()
              }
              return new Promise<void>((resolve) => {
                streamingEndForwardedResolve = resolve
              })
            }
            
            const streamingEndAcknowledger: PatchTransform = function* (input, output) {
              for (const patch of yield* each(input)) {
                yield* output.send(patch)
                if (patch.type === 'streaming_end' && !streamingEndForwarded) {
                  streamingEndForwarded = true
                  streamingEndForwardedResolve?.()
                  streamingEndForwardedResolve = null
                }
                yield* each.next()
              }
            }
            
            const transforms = options.transforms ?? []
            const streamPatches = yield* useTransformPipeline(patches, [
              ...transforms,
              streamingEndAcknowledger,
            ])
            
            const isomorphicToolsRegistry = yield* ToolRegistryContext.get()
            const isomorphicToolSchemas = isomorphicToolsRegistry
              ? isomorphicToolsRegistry.toToolSchemas().filter(
                  (schema: { name: string }) => !disabledToolNames.has(schema.name)
                )
              : undefined
            
            const contextStreamer = yield* StreamerContext.get()
            const streamer = contextStreamer ?? options.streamer ?? defaultStreamer
            
            // Convert history to API messages
            const currentMessages: Message[] = [...history]
            
            // Capture plugin elicit responses for this continuation
            let elicitResponsesToSend: ElicitResponseData[] = []
            
            // Run the continuation loop - may loop if plugin tools need multiple elicitations
            let result: StreamResult
            
            // eslint-disable-next-line no-constant-condition
            while (true) {
              // Move pending responses to this request (only on first iteration or if new ones arrived)
              if (pendingElicitResponses.length > 0) {
                elicitResponsesToSend = [...pendingElicitResponses]
                pendingElicitResponses.length = 0
              }
              
              result = yield* streamer(
                currentMessages,
                streamPatches,
                {
                  ...options,
                  ...(isomorphicToolSchemas != null && { isomorphicToolSchemas }),
                  ...(elicitResponsesToSend.length > 0 && { elicitResponses: elicitResponsesToSend }),
                }
              )
              
              // Clear plugin responses after sending (they've been processed)
              elicitResponsesToSend = []
              
              // If complete, we're done
              if (result.type === 'complete') {
                break
              }
              
              // Elicitation - sync conversation state and break the loop
              if (result.type === 'elicit') {
                // CRITICAL: Sync conversation state to history so the next request
                // includes the assistant message with tool_calls. Without this,
                // the next request will send tool results to OpenAI without the
                // corresponding tool_calls, causing "No tool call found" errors.
                
                pendingToolCalls = syncConversationStateForElicit(
                  history,
                  result.conversationState
                )
                resetTranscriptState(transcriptState, history)

                const assistantElicitHostMessage = [...history].reverse().find(
                  (message) =>
                    message.role === 'assistant' &&
                    message.content === '' &&
                    !message.tool_calls?.length &&
                    typeof message.id === 'string' &&
                    message.id.startsWith('assistant:final:')
                )
                if (assistantElicitHostMessage) {
                  yield* patches.send({
                    type: 'assistant_message',
                    message: assistantElicitHostMessage,
                  })
                }
                
                // Patches have already been emitted by stream-chat.
                // React state now has the pending elicitations in pendingElicits.
                // The UI will render based on this state and collect user responses.
                // When user responds, another 'continue' command will be dispatched.
                break
              }

              if (result.type === 'isomorphic_handoff') {
                syncConversationStateForComplete(history, result.conversationState)
                resetTranscriptState(transcriptState, history)
                break
              }
               
              // Unknown result type - shouldn't happen
              break
            }
            
            // Handle final result
            if (result.type === 'complete') {
              // Tool calls completed - clear pending tracking
              pendingToolCalls = []
              
              const completeResult = result as { 
                type: 'complete'
                text: string
                toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
                toolResults?: Array<{ id: string; name: string; content: string }>
              }
              // Sync tool calls and results to history
              // This is critical for multi-turn tool conversations where the LLM
              // makes multiple tool calls in sequence (like in tictactoe)
              if (completeResult.toolCalls && completeResult.toolCalls.length > 0) {
                appendAssistantToolCallMessage(
                  history,
                  transcriptState,
                  completeResult.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments as Record<string, unknown>,
                    },
                  })),
                  '',
                )
              }
              
              if (completeResult.toolResults && completeResult.toolResults.length > 0) {
                // Add tool result messages
                for (const tr of completeResult.toolResults) {
                  appendToolMessage(history, transcriptState, tr.id, tr.content)
                }
              }
              
              // Only add assistant message if there's content
              if (completeResult.text) {
                const assistantMessage = appendAssistantFinalMessage(history, transcriptState, completeResult.text)
                
                yield* patches.send({
                  type: 'assistant_message',
                  message: assistantMessage,
                })
              }
            }
            // elicit result: patches already emitted, session waits for user response
            
            yield* streamPatches.send({ type: 'streaming_end' })
            streamingEndSent = true
            yield* call(waitForStreamingEndForwarded)
            yield* streamPatches.close()
            
            return result
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            yield* patches.send({ type: 'error', message })
            yield* patches.send({ type: 'streaming_end' })
            streamingEndSent = true
            throw error
          } finally {
            if (!streamingEndSent) {
              yield* patches.send({ type: 'streaming_end' })
            }
            currentRequestTask = null
          }
        })
        break
      }

      case 'elicit_response': {
        // Ignore duplicate responses from stale/historical plugin UIs. A given
        // elicitation id can be answered only once; further clicks should not
        // enqueue another continuation while the remote tool has advanced.
        if (sentElicitResponseIds.has(cmd.elicitId)) {
          break
        }
        sentElicitResponseIds.add(cmd.elicitId)

        // Store the response to be sent with the next message (or continuation)
        pendingElicitResponses.push({
          sessionId: cmd.sessionId,
          callId: cmd.callId,
          ...(cmd.toolName ? { toolName: cmd.toolName } : {}),
          ...(cmd.ref ? { ref: cmd.ref } : {}),
          elicitId: cmd.elicitId,
          result: cmd.result,
        })
        
        // Emit a patch to update the local state
        yield* patches.send({
          type: 'elicit_response',
          callId: cmd.callId,
          elicitId: cmd.elicitId,
          response: cmd.result,
        })
        
        // Auto-continue: trigger a continuation request to resume the tool
        // This enables seamless multi-step elicitation flows
        const shouldAutoContinue = cmd.autoContinue !== false // default true
        if (shouldAutoContinue) {
          commands.send({ type: 'continue' })
        }
        break
      }
    }

    yield* each.next()
  }
}
