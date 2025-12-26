/**
 * dualBuffer.ts
 *
 * Double-buffering transform for streaming content.
 *
 * ## The Double Buffer Pattern
 *
 * Like double buffering in game rendering:
 * - Back buffer (pending): Accumulating content, shown as raw text
 * - Front buffer (settled): Complete content, safe to parse/render
 *
 * ```
 * ┌─────────────────────┐     ┌─────────────────────┐
 * │  Pending Buffer     │     │  Settled Buffer     │
 * │  (accumulating)     │ ──► │  (displayed as MD)  │
 * │  raw text + cursor  │swap │  parsed, rendered   │
 * └─────────────────────┘     └─────────────────────┘
 * ```
 *
 * ## Settlers
 *
 * Content moves from pending → settled based on a pluggable "settler".
 * The settler yields content to settle, combining "when" and "what" elegantly.
 *
 * Built-in settlers (see settlers.ts):
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
 * ## Processors
 *
 * When content settles, a processor can enrich it with additional data:
 * - `markdown()` - parse to HTML
 * - `syntaxHighlight()` - progressive syntax highlighting
 *
 * Processors are Effection Operations that can:
 * - Do async work (yield* sleep(), yield* call())
 * - Emit multiple times for progressive enhancement
 * - Access settler metadata for context-aware processing
 *
 * ## Output Patches
 *
 * - `buffer_settled`: Chunk just moved to settled (with prev/next for diffing)
 *   - May include `html`, `ast`, `pass`, `meta`, etc. from processor
 * - `buffer_pending`: Current pending buffer (full replacement each time)
 *
 * ## Usage
 *
 * ```typescript
 * import { dualBufferTransform } from './dualBuffer'
 * import { paragraph, codeFence } from './settlers'
 * import { markdown, syntaxHighlight } from './processors'
 *
 * // Basic markdown parsing - pass factory functions, NOT instances
 * dualBufferTransform({
 *   settler: paragraph,      // factory reference (not paragraph())
 *   processor: markdown,     // factory reference (not markdown())
 * })
 * 
 * // Code fence aware with progressive syntax highlighting
 * dualBufferTransform({
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
   SettlerFactory,
   ProcessorChainFactory,
} from './types'
import { defaultSettlerFactory } from './settlers'
import { defaultProcessorFactory } from './processors'
import { createProcessorChain } from './processor-chain'

export interface DualBufferOptions {
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
   * @example
   * ```typescript
   * dualBufferTransform({
   *   settler: paragraph,    // correct: factory reference
   *   settler: codeFence,    // correct: factory reference
   *   settler: paragraph(),  // WRONG: creates single instance
   * })
   * ```
   * 
   * Default: paragraph - settle on paragraph breaks
   */
  settler?: SettlerFactory

   /**
    * Factory function(s) that create processor instance(s).
    *
    * Can be a single processor factory or an array of processor factories that run in sequence.
    * Pass the factory function(s) themselves, NOT called instances.
    * A fresh processor is created on each `streaming_start` to reset state.
    *
    * @example Single processor
    * ```typescript
    * dualBufferTransform({
    *   processor: markdown,          // correct: factory reference
    *   processor: shikiProcessor,    // correct: factory reference
    * })
    * ```
    *
    * @example Multiple processors (run in sequence)
    * ```typescript
    * dualBufferTransform({
    *   processor: [markdown, syntaxHighlight],  // markdown → syntax highlighting
    * })
    * ```
    *
    * @example Wrong usage
    * ```typescript
    * dualBufferTransform({
    *   processor: markdown(),        // WRONG: creates single instance
    * })
    * ```
    *
    * Default: passthrough - no enrichment
    */
   processor?: ProcessorChainFactory

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
 * Create a dual buffer transform.
 *
 * Converts `streaming_text` patches into `buffer_settled` and `buffer_pending`
 * patches, implementing the double-buffer pattern for smooth rendering.
 * 
 * **Important**: Pass factory functions, not instances. The transform creates
 * fresh settler/processor instances on each `streaming_start` to ensure state
 * is properly reset between streaming sessions.
 */
export function dualBufferTransform(
  options: DualBufferOptions = {}
): PatchTransform {
  const {
    settler: settlerFactory = defaultSettlerFactory,
    processor: processorInput = defaultProcessorFactory,
    debug = false
  } = options

  // Normalize processor input to always be a ProcessorFactory
  const processorFactory: () => any = Array.isArray(processorInput)
    ? createProcessorChain(processorInput)
    : processorInput

  return function* (
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
    let settled = ''
    let pending = ''
    let done = false
    
    // Create initial instances from factories
    let settler = settlerFactory()
    let processor = processorFactory()

    const log = debug
      ? (msg: string, data?: unknown) =>
          console.log(`[dualBuffer] ${msg}`, data ?? '')
      : () => {}

    // Subscribe to input channel
    const subscription: Subscription<ChatPatch, void> = yield* input

    // Helper to settle specific content with metadata
    function* settleChunk(content: string, meta?: SettleMeta): Operation<void> {
      if (!content) return

      const prev = settled
      const next = prev + content
      
      // Update state BEFORE running processor so emit sees correct state
      settled = next
      pending = pending.slice(content.length)
      
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
          }
        }
      }

      // Run the processor - it will yield* emit() to send patches immediately
      yield* processor(processorCtx, emit)

      log(`settling: "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}"`, {
        prevLen: prev.length,
        contentLen: content.length,
        nextLen: settled.length,
        remainingPending: pending.length,
        emitted,
      })

      // If processor emitted nothing, send a basic patch
      if (!emitted) {
        yield* output.send({
          type: 'buffer_settled',
          content,
          prev,
          next,
          ...(meta !== undefined && { meta }),
        })
      }
    }

    // Helper to settle ALL pending content (for stream end)
    function* settleAll(): Operation<void> {
      if (!pending) return
      
      // First, give the settler a chance to process with flush: true
      // This allows settlers like codeFence to handle incomplete content
      // (e.g., ``` without trailing newline)
      const flushCtx: SettleContext = {
        pending,
        elapsed: pendingStartTime ? Date.now() - pendingStartTime : 0,
        settled,
        patch: { type: 'streaming_end' },
        flush: true,
      }
      
      const results = [...settler(flushCtx)].map(normalizeSettlerResult)
      
      for (const result of results) {
        const { content, meta } = result
        if (!pending.startsWith(content)) {
          console.warn(
            `[dualBuffer] settler yielded content that's not a prefix of pending. ` +
            `Content: "${content.slice(0, 30)}...", Pending starts: "${pending.slice(0, 30)}..."`
          )
          continue
        }
        yield* settleChunk(content, meta)
      }
      
      // Settle any remaining content the settler didn't handle
      if (pending) {
        yield* settleChunk(pending)
      }
    }

    // Helper to emit pending update
    function* emitPending(): Operation<void> {
      log(`pending: "${pending.slice(-30)}"`, { len: pending.length })
      yield* output.send({
        type: 'buffer_pending',
        content: pending,
      })
    }

    // Helper to run settler and settle yielded content
    function* runSettler(patch: ChatPatch, elapsed: number): Operation<void> {
      const ctx: SettleContext = {
        pending,
        elapsed,
        settled,
        patch,
      }

      // Collect all results yielded by settler (handle both string and SettleResult)
      const results = [...settler(ctx)].map(normalizeSettlerResult)
      
      for (const result of results) {
        const { content, meta } = result
        
        // Validate: content must be prefix of current pending
        if (!pending.startsWith(content)) {
          console.warn(
            `[dualBuffer] settler yielded content that's not a prefix of pending. ` +
            `Content: "${content.slice(0, 30)}...", Pending starts: "${pending.slice(0, 30)}..."`
          )
          continue
        }
        yield* settleChunk(content, meta)
      }
    }

    // Track when pending content started accumulating
    let pendingStartTime: number | null = null

    // Main processing loop
    while (!done) {
      const next = yield* subscription.next()

      if (next.done) {
        // Stream ended - settle any remaining pending content
        done = true
        log('subscription ended (channel closed)', { pending: pending.length })
        if (pending) {
          log('stream ended, final settle')
          yield* settleAll()
        }
        break
      }

      const patch = next.value
      log('received patch:', patch.type)

      // Before processing new patch, run settler to check if anything should settle
      if (pending && pendingStartTime !== null) {
        const elapsed = Date.now() - pendingStartTime
        yield* runSettler(patch, elapsed)
        
        // Reset timer if we settled everything
        if (!pending) {
          pendingStartTime = null
        }
      }

      // Handle the patch by type
      if (patch.type === 'streaming_text') {
        // Start the clock when we first accumulate pending content
        if (pendingStartTime === null) {
          pendingStartTime = Date.now()
        }
        // Accumulate text in pending buffer
        pending += patch.content
        yield* emitPending()
        // ALSO pass through the original patch for step chain logic
        // The reducer uses streaming_text to build activeStep
        yield* output.send(patch)
      } else if (patch.type === 'streaming_start') {
        // Reset buffers AND create fresh settler/processor instances
        // This ensures no state leaks between streaming sessions
        settled = ''
        pending = ''
        pendingStartTime = null
        settler = settlerFactory()
        processor = processorFactory()
        yield* output.send(patch)
      } else if (patch.type === 'streaming_end') {
        // Settle any remaining content before ending
        log('streaming_end received', {
          pendingLen: pending.length,
          pendingContent: pending.slice(-100),
          settledLen: settled.length,
        })
        if (pending) {
          log('calling settleAll for pending content')
          yield* settleAll()
          log('settleAll completed', { settledLen: settled.length })
        }
        pendingStartTime = null
        yield* output.send(patch)
      } else {
        // Pass through other patch types unchanged
        yield* output.send(patch)
      }
    }
  }
}
