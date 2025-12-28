/**
 * tripleBuffer.test.ts
 *
 * Unit tests for triple buffer transform.
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, spawn, each, sleep } from 'effection'
import { tripleBufferTransform } from '../tripleBuffer'
import { paragraph } from '../settlers'
import type { ChatPatch } from '../types'

describe('tripleBufferTransform', () => {
  it('should accumulate raw content in buffer_raw patches', async () => {
    const result = await run(function* () {
      // Create input and output channels
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      // Collect all patches that come out of the transform
      const receivedPatches: ChatPatch[] = []

      // Spawn a consumer that collects output patches
      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      // Spawn the transform
      yield* spawn(function* () {
        yield* tripleBufferTransform()(input, output)
      })

      // Give consumer and transform time to subscribe
      yield* sleep(10)

      // Send streaming start
      yield* input.send({ type: 'streaming_start' })

      // Send some text
      yield* input.send({ type: 'streaming_text', content: 'Hello ' })
      yield* input.send({ type: 'streaming_text', content: 'world\n\n' })

      // Close input to end the stream
      input.close()

      // Wait a bit for processing
      yield* sleep(10)

      return receivedPatches
    })

    // Should have buffer_raw patches
    const rawPatches = result.filter(p => p.type === 'buffer_raw')
    expect(rawPatches).toHaveLength(2)
    expect(rawPatches[0]).toEqual({ type: 'buffer_raw', content: 'Hello ' })
    expect(rawPatches[1]).toEqual({ type: 'buffer_raw', content: 'Hello world\n\n' })
  })

  it('should settle content with paragraph chunker', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      yield* spawn(function* () {
        yield* tripleBufferTransform({ chunker: paragraph })(input, output)
      })

      yield* sleep(10)

      yield* input.send({ type: 'streaming_start' })
      yield* input.send({ type: 'streaming_text', content: 'First paragraph.\n\n' })
      yield* input.send({ type: 'streaming_text', content: 'Second paragraph.' })

      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Should have buffer_settled patch for the paragraph
    const settledPatches = result.filter(p => p.type === 'buffer_settled')
    expect(settledPatches).toHaveLength(1)
    expect(settledPatches[0]).toMatchObject({
      type: 'buffer_settled',
      content: 'First paragraph.\n\n',
      prev: '',
      next: 'First paragraph.\n\n'
    })
  })

  it('should emit buffer_renderable patches after processing', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      yield* spawn(function* () {
        yield* tripleBufferTransform({
          chunker: paragraph
        })(input, output)
      })

      yield* sleep(10)

      yield* input.send({ type: 'streaming_start' })
      yield* input.send({ type: 'streaming_text', content: 'Hello **world**\n\n' })
      yield* input.send({ type: 'streaming_end' })

      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Should have buffer_renderable patch
    const renderablePatches = result.filter(p => p.type === 'buffer_renderable')
    expect(renderablePatches).toHaveLength(1)
    expect(renderablePatches[0]).toMatchObject({
      type: 'buffer_renderable',
      prev: '',
      next: 'Hello **world**\n\n'
    })
  })

  it('should handle streaming_end by processing remaining content', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      yield* spawn(function* () {
        yield* tripleBufferTransform({ chunker: paragraph })(input, output)
      })

      yield* sleep(10)

      yield* input.send({ type: 'streaming_start' })
      yield* input.send({ type: 'streaming_text', content: 'Incomplete paragraph' })
      yield* input.send({ type: 'streaming_end' })

      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Should have buffer_settled patch for remaining content at end
    const settledPatches = result.filter(p => p.type === 'buffer_settled')
    expect(settledPatches).toHaveLength(1)
    expect(settledPatches[0]).toMatchObject({
      type: 'buffer_settled',
      content: 'Incomplete paragraph',
      prev: '',
      next: 'Incomplete paragraph'
    })
  })
})