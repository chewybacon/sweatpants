/**
 * testing.ts
 *
 * Test utilities for the chat session.
 *
 * Provides a controllable streamer that can be used to step through
 * streaming events in tests, enabling end-to-end testing of the full
 * session pipeline without network dependencies.
 *
 * ## Usage
 *
 * ```typescript
 * import { run, createSignal, createChannel, spawn } from 'effection'
 * import { runChatSession } from './session'
 * import { createTestStreamer } from './testing.ts'
 *
 * const result = await run(function* () {
 *   const { streamer, controls } = createTestStreamer()
 *   const commands = createSignal<ChatCommand, void>()
 *   const patches = createChannel<ChatPatch, void>()
 *   const received: ChatPatch[] = []
 *
 *   // Collect patches
 *   yield* spawn(function* () {
 *     for (const patch of yield* each(patches)) {
 *       received.push(patch)
 *       yield* each.next()
 *     }
 *   })
 *
 *   // Run session with test streamer
 *   yield* spawn(function* () {
 *     yield* runChatSession(commands, patches, {
 *       streamer,
 *       transforms: [dualBufferTransform()],
 *     })
 *   })
 *
 *   // Send a message
 *   commands.send({ type: 'send', content: 'Hello' })
 *   yield* sleep(10)
 *
 *   // Step through streaming
 *   yield* controls.emit({ type: 'text', content: 'Hello ' })
 *   yield* controls.emit({ type: 'text', content: 'world!' })
 *   yield* controls.complete('Hello world!')
 *
 *   yield* sleep(50)
 *   return received
 * })
 * ```
 */
import type { Operation } from 'effection'
import { createSignal, each } from 'effection'
import type { StreamEvent, Streamer, StreamResult, ConversationState } from './types.ts'
import type { IsomorphicHandoffEvent } from '../../lib/chat/types.ts'

/**
 * Controls for a test streamer.
 *
 * These methods let you step through streaming events in tests.
 */
export interface TestStreamerControls {
  /**
   * Emit a stream event (like receiving from the API).
   * This will cause the streamer to emit the corresponding patch.
   */
  emit(event: StreamEvent): Operation<void>

  /**
   * Complete the stream with the final text.
   * This simulates receiving the 'complete' event from the API.
   */
  complete(finalText: string): Operation<void>

  /**
   * Complete the stream with an isomorphic handoff.
   * This simulates the server handing off to client for tool execution.
   */
  completeWithHandoff(
    handoffs: IsomorphicHandoffEvent[],
    conversationState: ConversationState
  ): Operation<void>

  /**
   * Emit an error and optionally end the stream.
   */
  error(message: string, recoverable?: boolean): Operation<void>

  /**
   * Wait for the streamer to be ready (called by session).
   * Returns a promise that resolves when the streamer starts.
   */
  waitForStart(): Promise<void>
}

/**
 * Result of createTestStreamer.
 */
export interface TestStreamer {
  /** The streamer function to pass to SessionOptions */
  streamer: Streamer

  /** Controls to step through streaming events */
  controls: TestStreamerControls
}

/**
 * Create a test streamer with step-through controls.
 *
 * The streamer will wait for events from the controls before emitting
 * patches, giving you full control over timing in tests.
 *
 * @example
 * ```typescript
 * const { streamer, controls } = createTestStreamer()
 *
 * // In your session options:
 * { streamer, transforms: [...] }
 *
 * // In your test:
 * yield* controls.emit({ type: 'text', content: 'Hello' })
 * yield* controls.complete('Hello')
 * ```
 */
export function createTestStreamer(): TestStreamer {
  // Signal for events from controls -> streamer
  type InternalEvent = 
    | StreamEvent 
    | { type: '__complete__'; text: string }
    | { type: '__handoff__'; handoffs: IsomorphicHandoffEvent[]; conversationState: ConversationState }
  const eventSignal = createSignal<InternalEvent, void>()

  // Promise to notify when streamer starts
  let resolveStart: () => void
  const startPromise = new Promise<void>((resolve) => {
    resolveStart = resolve
  })

  // Track final text for return value
  let finalText = ''
  // Track handoff result if completing with handoff
  let handoffResult: { handoffs: IsomorphicHandoffEvent[]; conversationState: ConversationState } | null = null

  const streamer: Streamer = function* (_messages, patches, _options): Operation<StreamResult> {
    // Notify that we've started
    resolveStart()

    // Listen for events from controls
    for (const event of yield* each(eventSignal)) {
      if (event.type === '__complete__') {
        // Complete event - set final text and exit
        // DON'T call each.next() here - break exits immediately
        finalText = event.text
        break
      }

      if (event.type === '__handoff__') {
        // Handoff event - save for return value and exit
        handoffResult = { handoffs: event.handoffs, conversationState: event.conversationState }
        break
      }

      // Process the stream event (same logic as streamChatOnce)
      switch (event.type) {
        case 'session_info':
          yield* patches.send({
            type: 'session_info',
            capabilities: event.capabilities,
            persona: event.persona,
          })
          break

        case 'text':
          finalText += event.content
          yield* patches.send({ type: 'streaming_text', content: event.content })
          break

        case 'thinking':
          yield* patches.send({
            type: 'streaming_reasoning',
            content: event.content,
          })
          break

        case 'tool_calls':
          for (const call of event.calls) {
            yield* patches.send({
              type: 'tool_call_start',
              call: {
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })
          }
          break

        case 'tool_result':
          yield* patches.send({
            type: 'tool_call_result',
            id: event.id,
            result: event.content,
          })
          break

        case 'tool_error':
          yield* patches.send({
            type: 'tool_call_error',
            id: event.id,
            error: event.message,
          })
          break

        case 'complete':
          // Final text from server (authoritative)
          finalText = event.text
          break

        case 'error':
          yield* patches.send({ type: 'error', message: event.message })
          if (!event.recoverable) {
            throw new Error(event.message)
          }
          break
      }

      yield* each.next()
    }

    // Return handoff result if we have one, otherwise complete with text
    if (handoffResult) {
      return { type: 'isomorphic_handoff', ...handoffResult }
    }
    return { type: 'complete', text: finalText }
  }

  const controls: TestStreamerControls = {
    *emit(event: StreamEvent) {
      eventSignal.send(event)
    },

    *complete(text: string) {
      eventSignal.send({ type: '__complete__', text })
    },

    *completeWithHandoff(
      handoffs: IsomorphicHandoffEvent[],
      conversationState: ConversationState
    ) {
      eventSignal.send({ type: '__handoff__', handoffs, conversationState })
    },

    *error(message: string, recoverable = false) {
      eventSignal.send({ type: 'error', message, recoverable })
      if (!recoverable) {
        eventSignal.send({ type: '__complete__', text: '' })
      }
    },

    waitForStart() {
      return startPromise
    },
  }

  return { streamer, controls }
}

/**
 * Helper to create a simple sync streamer for quick tests.
 *
 * Immediately emits all events and completes - no stepping required.
 *
 * @param events - Events to emit in order
 * @param finalText - Final text to return
 */
export function createImmediateStreamer(
  events: StreamEvent[],
  finalText: string
): Streamer {
  return function* (_messages, patches, _options) {
    for (const event of events) {
      switch (event.type) {
        case 'text':
          yield* patches.send({ type: 'streaming_text', content: event.content })
          break
        case 'thinking':
          yield* patches.send({ type: 'streaming_reasoning', content: event.content })
          break
        case 'complete':
          // Ignore, we use finalText parameter
          break
        // Add other event types as needed
      }
    }
    return { type: 'complete', text: finalText }
  }
}
