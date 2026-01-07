import { describe, it, expect } from 'vitest'
import { run, spawn, each, call } from 'effection'
import { createChatSession } from '../create-session'
import type { ChatState } from '../../state/chat-state'
import type { Streamer, PatchTransform } from '../options'
import type { ChatPatch } from '../../patches'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label} after ${ms}ms`))
    }, ms)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

describe('createChatSession streaming_end acknowledgement', () => {
  it('waits for transforms to forward streaming_end before returning', async () => {
    await run(function* () {
      // Controlled barrier used by the slow transform.
      let releaseStreamingEnd: (() => void) | null = null
      const streamingEndBarrier = new Promise<void>((resolve) => {
        releaseStreamingEnd = resolve
      })

      let streamingEndSeenResolve: (() => void) | null = null
      const streamingEndSeen = new Promise<void>((resolve) => {
        streamingEndSeenResolve = resolve
      })

      const slowStreamingEndTransform: PatchTransform = function* (input, output) {
        for (const patch of yield* each(input)) {
          if (patch.type === 'streaming_end') {
            streamingEndSeenResolve?.()
            streamingEndSeenResolve = null
            yield* call(() => streamingEndBarrier)
          }

          yield* output.send(patch)
          yield* each.next()
        }
      }

      const streamer: Streamer = function* (_messages, patches) {
        yield* patches.send({ type: 'streaming_text', content: '```python\nprint("hello")\n```' })
        return { type: 'complete', text: '```python\nprint("hello")\n```' }
      }

      const { state, dispatch } = yield* createChatSession({
        streamer,
        transforms: [slowStreamingEndTransform],
      })

      let latestState: ChatState | null = null
      let sawStreamingStart = false

      let sawStreamingStartResolve: (() => void) | null = null
      const sawStreamingStartPromise = new Promise<void>((resolve) => {
        sawStreamingStartResolve = resolve
      })

      let sawStreamingEndResolve: (() => void) | null = null
      const sawStreamingEndPromise = new Promise<void>((resolve) => {
        sawStreamingEndResolve = resolve
      })

      // Continuously consume state updates so we don't miss any.
      yield* spawn(function* () {
        for (const s of yield* each(state)) {
          latestState = s
          if (!sawStreamingStart && s.isStreaming) {
            sawStreamingStart = true
            sawStreamingStartResolve?.()
            sawStreamingStartResolve = null
          }

          if (sawStreamingStart && !s.isStreaming) {
            sawStreamingEndResolve?.()
            sawStreamingEndResolve = null
          }

          yield* each.next()
        }
      })

      // Give spawned reducer/session loops a chance to subscribe to channels
      // before we dispatch the first command.
      yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

      dispatch({ type: 'send', content: 'Write python hello world' })

      // Confirm we entered streaming state.
      yield* call(() => withTimeout(sawStreamingStartPromise, 5000, 'streaming_start'))

      // Confirm the transform chain has received streaming_end (but is blocked).
      yield* call(() => withTimeout(streamingEndSeen, 5000, 'transform to receive streaming_end'))

      // At this point, streaming_end has NOT been forwarded to the reducer yet.
      expect(latestState?.isStreaming).toBe(true)

      // Release the transform so it can forward streaming_end.
      releaseStreamingEnd?.()
      releaseStreamingEnd = null

      // Now we should observe streaming_end in state.
      yield* call(() => withTimeout(sawStreamingEndPromise, 5000, 'streaming_end in state'))
      expect(latestState?.isStreaming).toBe(false)
    })
  })

  it('does not deadlock when streaming_end is forwarded immediately', async () => {
    await run(function* () {
      const passthrough: PatchTransform = function* (input, output) {
        for (const patch of yield* each(input)) {
          yield* output.send(patch)
          yield* each.next()
        }
      }

      const streamer: Streamer = function* (_messages, patches) {
        yield* patches.send({ type: 'streaming_text', content: 'hi' })
        return { type: 'complete', text: 'hi' }
      }

      const { state, dispatch } = yield* createChatSession({
        streamer,
        transforms: [passthrough],
      })

      let sawStreamingEndResolve: (() => void) | null = null
      const sawStreamingEndPromise = new Promise<void>((resolve) => {
        sawStreamingEndResolve = resolve
      })

      yield* spawn(function* () {
        for (const s of yield* each(state)) {
          if (!s.isStreaming && s.messages.length > 0) {
            sawStreamingEndResolve?.()
            sawStreamingEndResolve = null
          }
          yield* each.next()
        }
      })

      yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

      dispatch({ type: 'send', content: 'hi' })
      yield* call(() => withTimeout(sawStreamingEndPromise, 5000, 'streaming_end'))
    })
  })

  it('acknowledgement transform forwards patches unchanged', async () => {
    await run(function* () {
      const patchesSeen: ChatPatch[] = []

      const collectingTransform: PatchTransform = function* (input, output) {
        for (const patch of yield* each(input)) {
          patchesSeen.push(patch)
          yield* output.send(patch)
          yield* each.next()
        }
      }

      const streamer: Streamer = function* (_messages, patches) {
        yield* patches.send({ type: 'streaming_text', content: 'hello' })
        return { type: 'complete', text: 'hello' }
      }

      const { state, dispatch } = yield* createChatSession({
        streamer,
        transforms: [collectingTransform],
      })

      let doneResolve: (() => void) | null = null
      const done = new Promise<void>((resolve) => {
        doneResolve = resolve
      })

      yield* spawn(function* () {
        for (const s of yield* each(state)) {
          if (!s.isStreaming && s.messages.length > 0) {
            doneResolve?.()
            doneResolve = null
          }
          yield* each.next()
        }
      })

      yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

      dispatch({ type: 'send', content: 'hello' })
      yield* call(() => withTimeout(done, 5000, 'session completion'))

      // Ensure we saw the streaming_end patch forwarded through our transform.
      expect(patchesSeen.some((p) => p.type === 'streaming_end')).toBe(true)
    })
  })
})
