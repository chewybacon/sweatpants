/**
 * tripleBuffer.ts
 *
 * Triple-buffering transform for streaming content.
 *
 * ## The Triple Buffer Pattern
 *
 * Three-stage pipeline for streaming AI content:
 * - Raw buffer: Incoming tokens, accumulating as they arrive
 * - Settled buffer: Pool of "safe" content that settlers have confirmed complete
 * - Render buffer: Frame-based output (prev/next) for smooth React consumption
 *
 * ```
 * ┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
 * │   RAW BUFFER      │ ──►  │   SETTLED BUFFER  │ ──►  │   RENDER BUFFER   │
 * │   (tokens)        │      │   (parsed chunks) │      │   (frames)        │
 * │                   │      │                   │      │                   │
 * │ • accumulates     │      │ • settler decides │      │ • prev frame      │
 * │   incoming text   │      │   when to move    │      │ • next frame      │
 * │ • high frequency  │      │ • processor       │      │ • delta (new)     │
 * │                   │      │   enriches (html) │      │ • React consumes  │
 * └───────────────────┘      └───────────────────┘      └───────────────────┘
 * ```
 *
 * ## Vocabulary
 *
 * - **Settler**: Decides WHEN content moves from raw → settled (yields chunks + metadata)
 * - **Processor**: Enriches settled content (yields html/ast/metadata)
 * - **Buffer**: Accumulated state at each stage
 * - **Frame**: prev/next snapshot with delta for React to consume/animate
 *
 * ## Settlers (see settlers.ts)
 *
 * Content moves from raw → settled based on a pluggable "settler".
 * The settler yields content to settle, combining "when" and "what" elegantly.
 *
 * Built-in settlers:
 * - `timeout(ms)` - settle after time elapsed
 * - `paragraph()` - settle on \n\n
 * - `sentence()` - settle on sentence endings
 * - `line()` - settle on \n
 * - `maxSize(chars)` - settle when buffer exceeds size
 * - `codeFence()` - line-by-line in fences, paragraph outside (with metadata)
 *
 * Combinators:
 * - `any(...)` - first settler that yields wins
 * - `all(...)` - all must agree, smallest wins
 *
 * ## Processors (see processors.ts)
 *
 * When content settles, processors transform it for rendering:
 * - `markdown()` - parse to HTML
 * - `syntaxHighlight()` - progressive syntax highlighting (quick pass → full pass)
 *
 * Processors are Effection Operations that can:
 * - Do async work (yield* call(...))
 * - Emit multiple times for progressive enhancement
 * - Access settler metadata for context-aware processing
 *
 * ## Output Patches
 *
 * - `buffer_raw`: Current raw buffer content
 * - `buffer_settled`: Chunk moved to settled (with prev/next for diffing)
 * - `buffer_renderable`: Render frame (prev/next/delta for animation)
 *
 * ## Usage
 *
 * ```typescript
 * import { tripleBufferTransform } from './tripleBuffer'
 * import { paragraph, codeFence } from './settlers'
 * import { markdown, syntaxHighlight } from './processors'
 *
 * // Basic markdown parsing
 * tripleBufferTransform({
 *   settler: paragraph,      // factory reference
 *   processor: markdown,     // factory reference
 * })
 *
 * // Code fence aware with progressive syntax highlighting
 * tripleBufferTransform({
 *   settler: codeFence,           // factory reference
 *   processor: syntaxHighlight,   // factory reference
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
   * Factory function that creates a settler instance.
   *
   * Pass the factory function itself, NOT a called instance.
   * A fresh settler is created on each `streaming_start` to reset state.
   *
   * Can return either:
   * - Settler: yields strings (simple)
   * - MetadataSettler: yields SettleResult with metadata (for code fences, etc.)
   *
   * Default: paragraph - settle on paragraph breaks
   */
  settler?: SettlerFactory

  /**
   * @deprecated Use `settler` instead. Will be removed in next major version.
   */
  chunker?: SettlerFactory

  /**
   * Chain of processor factories that run in sequence.
   *
   * Can be a single processor factory or an array of factories.
   * Each processor receives the output of the previous as input.
   * Pass factory functions, NOT called instances.
   *
   * Default: passthrough (no processing)
   */
  processor?: ProcessorChain

  /**
   * @deprecated Use `processor` instead. Will be removed in next major version.
   */
  enhancer?: ProcessorChain

  /**
   * Enable debug logging.
   * Default: false
   */
  debug?: boolean
}

/**
 * Normalize settler result to SettleResult format.
 * Handles both Settler (yields strings) and MetadataSettler (yields SettleResult).
 */
function normalizeSettlerResult(result: string | SettleResult): SettleResult {
  if (typeof result === 'string') {
    return { content: result }
  }
  return result
}

/**
 * Renderable buffer state - frame-based output for React consumption
 */
interface RenderableBuffer {
  prev: string
  next: string
  html?: string
  /** HTML for just the new content (delta) */
  deltaHtml?: string
  /** Timestamp when this frame was produced */
  timestamp?: number
  meta?: SettleMeta
}

/**
 * Create a triple buffer transform.
 *
 * Converts `streaming_text` patches into `buffer_raw`, `buffer_settled`, and `buffer_renderable`
 * patches, implementing the triple-buffer pattern for smooth rendering.
 *
 * **Important**: Pass factory functions, not instances. The transform creates
 * fresh settler/processor instances on each `streaming_start` to ensure state
 * is properly reset between streaming sessions.
 */
export function tripleBufferTransform(
  options: TripleBufferOptions = {}
): PatchTransform {
  const {
    // Support both new names and deprecated aliases
    settler: settlerOpt,
    chunker: chunkerOpt,
    processor: processorOpt,
    enhancer: enhancerOpt,
    debug = false
  } = options

  // Use settler/processor, fall back to deprecated chunker/enhancer
  const settlerFactory = settlerOpt ?? chunkerOpt ?? defaultSettlerFactory
  const processorInput = processorOpt ?? enhancerOpt ?? defaultProcessorFactory

  // Create processor chain from array or single processor
  const processorFactory = createProcessorChain(processorInput)

  return function*(
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
    let raw = ''
    let settled = ''
    let renderable: RenderableBuffer = { prev: '', next: '' }
    let done = false

    // Create initial instances from factories
    let settler = settlerFactory()
    let processor = processorFactory()

    const log = debug
      ? (msg: string, data?: unknown) =>
        console.log(`[tripleBuffer] ${msg}`, data ?? '')
      : () => { }

    // Subscribe to input channel
    const subscription: Subscription<ChatPatch, void> = yield* input

    // Helper to process chunk through processor and update renderable buffer
    function* processChunk(content: string, meta?: SettleMeta): Operation<void> {
      if (!content) return

      const prev = settled
      const next = prev + content

      // Update settled state BEFORE running processor
      settled = next
      raw = raw.slice(content.length)

      // Build processor context with metadata from settler
      const processorCtx: ProcessorContext = {
        chunk: content,
        accumulated: prev,
        next,
        ...(meta !== undefined && { meta }),
      }

      // Track if processor emitted anything
      let emitted = false

      // Create emit operation - when processor yield* emit(...), it sends immediately
      function emit(processed: ProcessedOutput): Operation<void> {
        return {
          *[Symbol.iterator]() {
            emitted = true
            const now = Date.now()
            const patch: BufferSettledPatch = {
              type: 'buffer_settled',
              content,
              prev,
              next,
              ...(meta !== undefined && { meta }),
              ...processed,  // spread processor enrichments (html, ast, pass, etc.)
            }
            log(`emit: pass=${processed.pass || 'none'}, hasHtml=${!!processed.html}`)
            yield* output.send(patch)

            // Update renderable buffer with processed content
            // Preserve previous html if processor didn't provide new html
            const newRenderable: RenderableBuffer = {
              prev: renderable.next,
              next: next,
              timestamp: now,
              // Preserve previous html if not replaced
              ...(renderable.html && { html: renderable.html }),
            }
            if (processed.html) {
              newRenderable.html = processed.html
            }
            // Store delta HTML if the processor provided chunk-specific HTML
            if (processed['deltaHtml'] || processed['chunkHtml']) {
              newRenderable.deltaHtml = (processed['deltaHtml'] || processed['chunkHtml']) as string
            }
            if (processed['meta']) {
              newRenderable.meta = processed['meta'] as SettleMeta
            }
            renderable = newRenderable

            // Build delta information for animation support
            const delta = {
              added: content,
              startOffset: prev.length,
              ...(newRenderable.deltaHtml && { addedHtml: newRenderable.deltaHtml }),
            }

            // Extract reveal hint if processor provided one
            const revealHint = processed['revealHint'] as BufferRenderablePatch['revealHint'] | undefined

            // Emit renderable buffer update with full frame data
            const renderablePatch: BufferRenderablePatch = {
              type: 'buffer_renderable',
              prev: renderable.prev,
              next: renderable.next,
              delta,
              timestamp: now,
              ...(renderable.html && { html: renderable.html }),
              ...(revealHint && { revealHint }),
              ...(renderable.meta && { meta: renderable.meta }),
            }
            yield* output.send(renderablePatch)
          }
        }
      }

      // Run the processor - it will yield* emit() to send patches immediately
      yield* processor(processorCtx, emit)

      log(`processed: "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}"`, {
        prevLen: prev.length,
        contentLen: content.length,
        nextLen: settled.length,
        remainingRaw: raw.length,
        emitted,
      })

      // If processor emitted nothing, send basic patches
      if (!emitted) {
        const now = Date.now()
        yield* output.send({
          type: 'buffer_settled',
          content,
          prev,
          next,
          ...(meta !== undefined && { meta }),
        })

        // Update renderable buffer without processing
        // Preserve previous html when processor doesn't emit (e.g., fence start)
        const prevHtml = renderable.html
        renderable = {
          prev: renderable.next,
          next: next,
          timestamp: now,
          // Preserve html from previous frame
          ...(prevHtml && { html: prevHtml }),
        }

        // Build delta for animation support
        const delta = {
          added: content,
          startOffset: prev.length,
        }

        yield* output.send({
          type: 'buffer_renderable',
          prev: renderable.prev,
          next: renderable.next,
          delta,
          timestamp: now,
          // Include preserved html in the patch
          ...(renderable.html && { html: renderable.html }),
        })
      }
    }

    // Helper to process ALL raw content (for stream end)
    function* processAll(): Operation<void> {
      if (!raw) return

      // First, give the settler a chance to process with flush: true
      const flushCtx: SettleContext = {
        pending: raw,
        elapsed: rawStartTime ? Date.now() - rawStartTime : 0,
        settled,
        patch: { type: 'streaming_end' },
        flush: true,
      }

      const results = [...settler(flushCtx)].map(normalizeSettlerResult)

      for (const result of results) {
        const { content, meta } = result
        if (!raw.startsWith(content)) {
          console.warn(
            `[tripleBuffer] settler yielded content that's not a prefix of raw. ` +
            `Content: "${content.slice(0, 30)}...", Raw starts: "${raw.slice(0, 30)}..."`
          )
          continue
        }
        yield* processChunk(content, meta)
      }

      // Process any remaining content the settler didn't handle
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

    // Helper to run settler and process yielded content
    function* runSettler(patch: ChatPatch, elapsed: number): Operation<void> {
      const ctx: SettleContext = {
        pending: raw,
        elapsed,
        settled,
        patch,
      }

      // Collect all results yielded by settler
      const results = [...settler(ctx)].map(normalizeSettlerResult)

      for (const result of results) {
        const { content, meta } = result

        // Validate: content must be prefix of current raw
        if (!raw.startsWith(content)) {
          console.warn(
            `[tripleBuffer] settler yielded content that's not a prefix of raw. ` +
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

      // Before processing new patch, run settler to check if anything should settle
      if (raw && rawStartTime !== null) {
        const elapsed = Date.now() - rawStartTime
        yield* runSettler(patch, elapsed)

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
        // Reset buffers AND create fresh settler/processor instances
        raw = ''
        settled = ''
        renderable = { prev: '', next: '' }
        rawStartTime = null
        settler = settlerFactory()
        processor = processorFactory()
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
