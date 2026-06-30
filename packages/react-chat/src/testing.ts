import type { Operation } from 'effection'
import { createSignal, each } from 'effection'
import type { StreamEvent, Streamer, StreamResult } from './types.ts'

export interface TestStreamerControls {
  emit(event: StreamEvent): Operation<void>
  complete(finalText: string): Operation<void>
  error(message: string, recoverable?: boolean): Operation<void>
  waitForStart(): Promise<void>
}

export interface TestStreamer {
  streamer: Streamer
  controls: TestStreamerControls
}

export function createTestStreamer(): TestStreamer {
  type InternalEvent = StreamEvent | { type: '__complete__'; text: string }
  const eventSignal = createSignal<InternalEvent, void>()

  let resolveStart: () => void
  const startPromise = new Promise<void>((resolve) => {
    resolveStart = resolve
  })

  let finalText = ''

  const streamer: Streamer = function* (_messages, patches, _options): Operation<StreamResult> {
    resolveStart()

    for (const event of yield* each(eventSignal)) {
      if (event.type === '__complete__') {
        finalText = event.text
        break
      }

      switch (event.type) {
        case 'session_info':
          yield* patches.send({
            type: 'session_info',
            capabilities: event.capabilities,
            persona: event.persona,
          })
          break
        case 'ag_ui_text_message_content':
          finalText += event.delta
          yield* patches.send({ type: 'streaming_text', content: event.delta })
          break
        case 'thinking':
          yield* patches.send({ type: 'streaming_reasoning', content: event.content })
          break
        case 'ag_ui_tool_call_result':
          yield* patches.send({ type: 'tool_call_result', id: event.toolCallId, result: event.content })
          break
        case 'ag_ui_tool_call_error':
          yield* patches.send({ type: 'tool_call_error', id: event.toolCallId, error: event.message })
          break
        case 'error':
          yield* patches.send({ type: 'error', message: event.message })
          if (!event.recoverable) throw new Error(event.message)
          break
        default:
          break
      }

      yield* each.next()
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
    *error(message: string, recoverable = false) {
      eventSignal.send({ type: 'error', message, recoverable })
      if (!recoverable) eventSignal.send({ type: '__complete__', text: '' })
    },
    waitForStart() {
      return startPromise
    },
  }

  return { streamer, controls }
}

export function createImmediateStreamer(events: StreamEvent[], finalText: string): Streamer {
  return function* (_messages, patches, _options) {
    for (const event of events) {
      switch (event.type) {
        case 'ag_ui_text_message_content':
          yield* patches.send({ type: 'streaming_text', content: event.delta })
          break
        case 'thinking':
          yield* patches.send({ type: 'streaming_reasoning', content: event.content })
          break
        default:
          break
      }
    }
    return { type: 'complete', text: finalText }
  }
}
