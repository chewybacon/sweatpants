/**
 * lib/chat/session/transforms.ts
 *
 * Stream transform utilities for the chat session.
 *
 * ## What is a Transform?
 *
 * A transform is an Effection operation that sits between the streaming
 * source and the output channel:
 *
 * ```
 * streamChatOnce → inputChannel → [transform] → outputChannel → React
 * ```
 *
 * Transforms can:
 * - Buffer/debounce content (e.g., wait for complete markdown blocks)
 * - Parse/enrich content (e.g., syntax highlighting)
 * - Log/debug the stream (e.g., loggingTransform)
 * - Filter or modify patches
 *
 * ## The Subscribe-Before-Send Problem
 *
 * Effection channels are unbuffered - if you send() before anyone is
 * listening, the message is dropped. This is solved using Queue for buffering.
 *
 * ## The Buffered Channel Pattern
 *
 * `useTransformPipeline` uses a Queue-based approach:
 *
 * 1. Create a Queue to buffer messages (Queue.add() is sync, never drops)
 * 2. Spawn a forwarder that reads from Queue and sends to Channel
 * 3. Transforms subscribe to the Channel normally
 * 4. Return a Channel-like interface backed by the Queue
 *
 * This guarantees no messages are dropped, regardless of subscription timing.
 */
import type { Operation, Channel } from 'effection'
import { spawn, each, createChannel, resource, suspend, call } from 'effection'
import type { ChatPatch } from '../patches'
import type { PatchTransform } from './options'

/**
 * Create a buffered channel that won't drop messages sent before subscription.
 * 
 * Uses a Queue for buffering + Channel for pub/sub.
 * The forwarder waits for a subscriber before starting to forward messages.
 * close() waits for all messages to be delivered before completing.
 */
function useBufferedChannel<T>(): Operation<Channel<T, void>> {
  return resource<Channel<T, void>>(function* (provide) {
    // Queue for buffering messages
    const queue: T[] = []
    let closed = false
    let closeResolve: (() => void) | null = null
    let hasSubscriber = false
    let subscriberResolve: (() => void) | null = null
    let itemResolve: (() => void) | null = null
    
    // The underlying channel for actual pub/sub
    const channel = createChannel<T, void>()
    
    // Helper to wait for subscriber
    function waitForSubscriber(): Promise<void> {
      if (hasSubscriber) return Promise.resolve()
      return new Promise(resolve => { subscriberResolve = resolve })
    }
    
    // Helper to wait for item or close
    function waitForItem(): Promise<void> {
      if (queue.length > 0 || closed) return Promise.resolve()
      return new Promise(resolve => { itemResolve = resolve })
    }
    
    // Spawn a forwarder that reads from queue and sends to channel
    yield* spawn(function* () {
      // Wait for first subscriber before starting to forward
      yield* call(waitForSubscriber)
      
      while (true) {
        // Process all queued items
        while (queue.length > 0) {
          const item = queue.shift()!
          yield* channel.send(item)
        }
        
        // If closed and queue empty, close channel and exit
        if (closed && queue.length === 0) {
          yield* channel.close()
          if (closeResolve) closeResolve()
          break
        }
        
        // Wait for more items or close
        yield* call(waitForItem)
      }
    })
    
    // Create the interface that proxies to our queue + channel
    const bufferedChannel: Channel<T, void> = {
      *send(message: T) {
        queue.push(message)
        if (itemResolve) {
          itemResolve()
          itemResolve = null
        }
      },
      *close() {
        closed = true
        if (itemResolve) {
          itemResolve()
          itemResolve = null
        }
        // Wait for forwarder to finish delivering all messages
        yield* call(() => new Promise<void>(resolve => {
          closeResolve = resolve
        }))
      },
      // Delegate subscription to underlying channel
      [Symbol.iterator]: function* () {
        hasSubscriber = true
        if (subscriberResolve) {
          subscriberResolve()
          subscriberResolve = null
        }
        return yield* channel
      },
    }
    
    yield* provide(bufferedChannel)
  })
}

/**
 * Create a transform pipeline as a resource.
 *
 * This is the recommended way to use transforms. It returns a channel
 * that you write to, and transformed patches flow to the output channel.
 *
 * Uses buffered channels internally to guarantee no messages are dropped,
 * regardless of subscription timing.
 *
 * @example
 * ```typescript
 * // In your streaming code:
 * const inputChannel = yield* useTransformPipeline(outputChannel, [
 *   markdownTransform({ debounceMs: 100 }),
 * ])
 *
 * // Write to inputChannel - messages are buffered until transforms subscribe
 * yield* inputChannel.send({ type: 'streaming_text', content: 'Hello' })
 *
 * // Close when done to flush any buffered content
 * yield* inputChannel.close()
 * ```
 *
 * @param output - The final output channel where transformed patches go
 * @param transforms - Array of transforms to apply in order
 * @returns A channel to write input patches to
 */
export function useTransformPipeline(
  output: Channel<ChatPatch, void>,
  transforms: PatchTransform[]
): Operation<Channel<ChatPatch, void>> {
  return resource<Channel<ChatPatch, void>>(function* (provide) {
    // Create a buffered input channel - messages are queued until consumed
    const input = yield* useBufferedChannel<ChatPatch>()

    if (transforms.length === 0) {
      // No transforms - spawn a simple passthrough
      yield* spawn(function* () {
        yield* runPassthrough(input, output)
      })
    } else {
      // Spawn the transform chain
      yield* spawn(function* () {
        yield* runTransformChain(input, output, transforms)
      })
    }

    // No sleep(0) needed! The buffered channel queues messages until consumed.
    // Transforms will receive all messages when they subscribe.

    yield* provide(input)

    // Resource stays alive (suspended) until parent scope ends.
    // When it does, the spawned transform is automatically halted.
  })
}

/**
 * Run a passthrough that copies input to output.
 * Used when no transforms are configured.
 */
function* runPassthrough(
  input: Channel<ChatPatch, void>,
  output: Channel<ChatPatch, void>
): Operation<void> {
  for (const patch of yield* each(input)) {
    yield* output.send(patch)
    yield* each.next()
  }
}

/**
 * Run a chain of transforms.
 *
 * Creates intermediate channels between each transform:
 * input → t1 → ch1 → t2 → ch2 → ... → output
 *
 * Each transform runs as a spawned child, so they all run concurrently.
 * The chain completes when the input channel closes and all transforms
 * have processed their remaining data.
 */
function* runTransformChain(
  input: Channel<ChatPatch, void>,
  output: Channel<ChatPatch, void>,
  transforms: PatchTransform[]
): Operation<void> {
  // Build the chain of channels
  // input → t1 → ch1 → t2 → ch2 → ... → tn → output
  let current: Channel<ChatPatch, void> = input

  for (let i = 0; i < transforms.length; i++) {
    const transform = transforms[i]!
    const isLast = i === transforms.length - 1
    const next = isLast ? output : createChannel<ChatPatch, void>()

    // Capture for closure
    const source = current
    const dest = next

    // Spawn each transform as a concurrent child
    yield* spawn(function* () {
      yield* transform(source, dest)
      // When transform completes (input closed), close the output
      // so the next transform in chain knows to flush and finish
      if (!isLast) {
        yield* dest.close()
      }
    })

    current = next
  }

  // Keep this operation alive until all transforms complete.
  // The spawned children will finish when their inputs close.
  // We suspend here so the parent scope (the resource) controls lifetime.
  yield* suspend()
}

/**
 * Create a passthrough transform (useful for debugging or as a base).
 */
export function passthroughTransform(): PatchTransform {
  return function* (input, output) {
    for (const patch of yield* each(input)) {
      yield* output.send(patch)
      yield* each.next()
    }
  }
}

/**
 * Create a transform that logs all patches (for debugging).
 */
export function loggingTransform(label: string): PatchTransform {
  return function* (input, output) {
    for (const patch of yield* each(input)) {
      console.log(`[${label}]`, patch.type, patch)
      yield* output.send(patch)
      yield* each.next()
    }
  }
}
