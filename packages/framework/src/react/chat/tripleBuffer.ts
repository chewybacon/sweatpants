/**
 * tripleBuffer.ts
 *
 * Triple-buffering transform for streaming content.
 *
 * ## The Triple Buffer Pattern
 *
 * Extends double buffering with a renderable layer for smooth frame transitions:
 * - Raw buffer: Incoming tokens, accumulating
 * - Settled buffer: Confirmed chunks ready for processing (pool of safe data)
 * - Renderable buffer: Double buffer (prev/next) for smooth DOM updates
 *
 * ```
 * ┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
 * │   Raw Buffer        │ ──► │  Settled Buffer     │ ──► │ Renderable Buffer   │
 * │   (streaming)       │     │  (chunks)           │     │  (prev/next frames) │
 * │   tokens + cursor   │     │  processed content  │     │  smooth transitions │
 * └─────────────────────┘     └─────────────────────┘     └─────────────────────┘
 * ```
 *
 * ## Chunkers (renamed settlers)
 *
 * Content moves from raw → settled based on a pluggable "chunker".
 * The chunker yields content to settle, combining "when" and "what" elegantly.
 *
 * Built-in chunkers (see chunkers.ts):
 * - `timeout(ms)` - settle after time elapsed
 * - `paragraph()` - settle on \n\n
 * - `sentence()` - settle on sentence endings
 * - `line()` - settle on \n
 * - `maxSize(chars)` - settle when buffer exceeds size
 * - `codeFence()` - line-by-line in fences, paragraph outside (with metadata)
 *
 * Combinators:
 * - `any(...)` - first chunker that yields wins
 * - `all(...)` - all must agree, smallest wins
 *
 * ## Enhancers (renamed processors)
 *
 * When content settles, enhancers transform it for rendering:
 * - `markdown()` - parse to HTML
 * - `syntaxHighlight()` - progressive syntax highlighting
 *
 * Enhancers are Effection Operations that can:
 * - Do async work (yield* sleep(), yield* call())
 * - Emit multiple times for progressive enhancement
 * - Access chunker metadata for context-aware processing
 *
 * ## Output Patches
 *
 * - `buffer_raw`: Current raw buffer (full replacement each time)
 * - `buffer_settled`: Chunk moved to settled (with prev/next for diffing)
 * - `buffer_renderable`: Renderable buffer state (prev/next for frame transitions)
 *
 * ## Usage
 *
 * ```typescript
 * import { tripleBufferTransform } from './tripleBuffer'
 * import { paragraph, codeFence } from './chunkers'
 * import { markdown, syntaxHighlight } from './enhancers'
 *
 * // Basic markdown parsing
 * tripleBufferTransform({
 *   chunker: paragraph,      // factory reference
 *   enhancer: markdown,      // factory reference
 * })
 *
 * // Code fence aware with progressive syntax highlighting
 * tripleBufferTransform({
 *   chunker: codeFence,           // factory reference
 *   enhancer: syntaxHighlight,    // factory reference
 * })
 * ```
 *
 * **IMPORTANT**: Pass factory functions, not called instances. The transform
 * calls these factories on each `streaming_start` to ensure fresh state.
 */
import type { Operation, Channel, Subscription } from 'effection'
import type {
  ChatPatch,
  PatchTransform,
  SettleContext,
  SettleResult,
  SettleMeta,
  ProcessorContext,
  ProcessedOutput,
  BufferSettledPatch,
  BufferRenderablePatch,
  SettlerFactory,
  ProcessorChain,
} from './types'
import { defaultSettlerFactory } from './settlers'
import { defaultProcessorFactory } from './processors'
import { createProcessorChain } from './processor-chain'

export interface TripleBufferOptions {
  /**
   * Factory function that creates a chunker instance.
   *
   * Pass the factory function itself, NOT a called instance.
   * A fresh chunker is created on each `streaming_start` to reset state.
   *
   * Can return either:
   * - Chunker: yields strings (simple)
   * - MetadataChunker: yields SettleResult with metadata (for code fences, etc.)
   *
   * Default: paragraph - settle on paragraph breaks
   */
  chunker?: SettlerFactory

  /**
   * Chain of enhancer factories that run in sequence.
   *
   * Can be a single enhancer factory or an array of factories.
   * Each enhancer receives the output of the previous as input.
   * Pass factory functions, NOT called instances.
   *
   * Default: passthrough (no processing)
   */
  enhancer?: ProcessorChain

  /**
   * Enable debug logging.
   * Default: false
   */
  debug?: boolean
}

/**
 * Normalize chunker result to SettleResult format.
 * Handles both Chunker (yields strings) and MetadataChunker (yields SettleResult).
 */
function normalizeChunkerResult(result: string | SettleResult): SettleResult {
  if (typeof result === 'string') {
    return { content: result }
  }
  return result
}

/**
 * Renderable buffer state - double buffer for smooth transitions
 */
interface RenderableBuffer {
  prev: string
  next: string
  html?: string
  meta?: SettleMeta
}

/**
 * Create a triple buffer transform.
 *
 * Converts `streaming_text` patches into `buffer_raw`, `buffer_settled`, and `buffer_renderable`
 * patches, implementing the triple-buffer pattern for smooth rendering.
 *
 * **Important**: Pass factory functions, not instances. The transform creates
 * fresh chunker/enhancer instances on each `streaming_start` to ensure state
 * is properly reset between streaming sessions.
 */
export function tripleBufferTransform(
  options: TripleBufferOptions = {}
): PatchTransform {
  const {
    chunker: chunkerFactory = defaultSettlerFactory,
    enhancer: enhancerInput = defaultProcessorFactory,
    debug = false
  } = options

  // Create enhancer chain from array or single enhancer
  const enhancerFactory = createProcessorChain(enhancerInput)

  return function* (
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
    let raw = ''
    let settled = ''
    let renderable: RenderableBuffer = { prev: '', next: '' }
    let done = false

    // Create initial instances from factories
    let chunker = chunkerFactory()
    let enhancer = enhancerFactory()

    const log = debug
      ? (msg: string, data?: unknown) =>
          console.log(`[tripleBuffer] ${msg}`, data ?? '')
      : () => {}

    // Subscribe to input channel
    const subscription: Subscription<ChatPatch, void> = yield* input

    // Helper to process chunk through enhancer and update renderable buffer
    function* processChunk(content: string, meta?: SettleMeta): Operation<void> {
      if (!content) return

      const prev = settled
      const next = prev + content

      // Update settled state BEFORE running enhancer
      settled = next
      raw = raw.slice(content.length)

      // Build enhancer context with metadata from chunker
      const enhancerCtx: ProcessorContext = {
        chunk: content,
        accumulated: prev,
        next,
        ...(meta !== undefined && { meta }),
      }

      // Track if enhancer emitted anything
      let emitted = false

      // Create emit operation - when enhancer yield* emit(...), it sends immediately
      function emit(processed: ProcessedOutput): Operation<void> {
        return {
          *[Symbol.iterator]() {
            emitted = true
            const patch: BufferSettledPatch = {
              type: 'buffer_settled',
              content,
              prev,
              next,
              ...(meta !== undefined && { meta }),
              ...processed,  // spread enhancer enrichments (html, ast, pass, etc.)
            }
            log(`emit: pass=${processed.pass || 'none'}, hasHtml=${!!processed.html}`)
            yield* output.send(patch)

            // Update renderable buffer with processed content
            const newRenderable: RenderableBuffer = {
              prev: renderable.next,
              next: next,
            }
            if (processed.html) {
              newRenderable.html = processed.html
            }
            if (processed['meta']) {
              newRenderable.meta = processed['meta'] as SettleMeta
            }
            renderable = newRenderable

            // Emit renderable buffer update
            const renderablePatch: BufferRenderablePatch = {
              type: 'buffer_renderable',
              prev: renderable.prev,
              next: renderable.next,
            }
            if (renderable.html) {
              renderablePatch.html = renderable.html
            }
            if (renderable.meta) {
              renderablePatch.meta = renderable.meta
            }
            yield* output.send(renderablePatch)
          }
        }
      }

      // Run the enhancer - it will yield* emit() to send patches immediately
      yield* enhancer(enhancerCtx, emit)

      log(`processed: "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}"`, {
        prevLen: prev.length,
        contentLen: content.length,
        nextLen: settled.length,
        remainingRaw: raw.length,
        emitted,
      })

      // If enhancer emitted nothing, send basic patches
      if (!emitted) {
        yield* output.send({
          type: 'buffer_settled',
          content,
          prev,
          next,
          ...(meta !== undefined && { meta }),
        })

        // Update renderable buffer without processing
        renderable = {
          prev: renderable.next,
          next: next,
        }

        yield* output.send({
          type: 'buffer_renderable',
          prev: renderable.prev,
          next: renderable.next,
        })
      }
    }

    // Helper to process ALL raw content (for stream end)
    function* processAll(): Operation<void> {
      if (!raw) return

      // First, give the chunker a chance to process with flush: true
      const flushCtx: SettleContext = {
        pending: raw,
        elapsed: rawStartTime ? Date.now() - rawStartTime : 0,
        settled,
        patch: { type: 'streaming_end' },
        flush: true,
      }

      const results = [...chunker(flushCtx)].map(normalizeChunkerResult)

      for (const result of results) {
        const { content, meta } = result
        if (!raw.startsWith(content)) {
          console.warn(
            `[tripleBuffer] chunker yielded content that's not a prefix of raw. ` +
            `Content: "${content.slice(0, 30)}...", Raw starts: "${raw.slice(0, 30)}..."`
          )
          continue
        }
        yield* processChunk(content, meta)
      }

      // Process any remaining content the chunker didn't handle
      if (raw) {
        yield* processChunk(raw)
      }
    }

    // Helper to emit raw buffer update
    function* emitRaw(): Operation<void> {
      log(`raw: "${raw.slice(-30)}"`, { len: raw.length })
      yield* output.send({
        type: 'buffer_raw',
        content: raw,
      })
    }

    // Helper to run chunker and process yielded content
    function* runChunker(patch: ChatPatch, elapsed: number): Operation<void> {
      const ctx: SettleContext = {
        pending: raw,
        elapsed,
        settled,
        patch,
      }

      // Collect all results yielded by chunker
      const results = [...chunker(ctx)].map(normalizeChunkerResult)

      for (const result of results) {
        const { content, meta } = result

        // Validate: content must be prefix of current raw
        if (!raw.startsWith(content)) {
          console.warn(
            `[tripleBuffer] chunker yielded content that's not a prefix of raw. ` +
            `Content: "${content.slice(0, 30)}...", Raw starts: "${raw.slice(0, 30)}..."`
          )
          continue
        }
        yield* processChunk(content, meta)
      }
    }

    // Track when raw content started accumulating
    let rawStartTime: number | null = null

    // Main processing loop
    while (!done) {
      const next = yield* subscription.next()

      if (next.done) {
        // Stream ended - process any remaining raw content
        done = true
        log('subscription ended (channel closed)', { raw: raw.length })
        if (raw) {
          log('stream ended, final process')
          yield* processAll()
        }
        break
      }

      const patch = next.value
      log('received patch:', patch.type)

      // Before processing new patch, run chunker to check if anything should settle
      if (raw && rawStartTime !== null) {
        const elapsed = Date.now() - rawStartTime
        yield* runChunker(patch, elapsed)

        // Reset timer if we processed everything
        if (!raw) {
          rawStartTime = null
        }
      }

      // Handle the patch by type
      if (patch.type === 'streaming_text') {
        // Start the clock when we first accumulate raw content
        if (rawStartTime === null) {
          rawStartTime = Date.now()
        }
        // Accumulate text in raw buffer
        raw += patch.content
        yield* emitRaw()
        // Pass through the original patch for step chain logic
        yield* output.send(patch)
      } else if (patch.type === 'streaming_start') {
        // Reset buffers AND create fresh chunker/enhancer instances
        raw = ''
        settled = ''
        renderable = { prev: '', next: '' }
        rawStartTime = null
        chunker = chunkerFactory()
        enhancer = enhancerFactory()
        yield* output.send(patch)
      } else if (patch.type === 'streaming_end') {
        // Process any remaining content before ending
        log('streaming_end received', {
          rawLen: raw.length,
          rawContent: raw.slice(-100),
          settledLen: settled.length,
        })
        if (raw) {
          log('calling processAll for raw content')
          yield* processAll()
          log('processAll completed', { settledLen: settled.length })
        }
        rawStartTime = null
        yield* output.send(patch)
      } else {
        // Pass through other patch types unchanged
        yield* output.send(patch)
      }
    }
  }
}