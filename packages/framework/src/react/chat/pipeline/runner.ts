/**
 * pipeline/runner.ts
 *
 * Lazy pipeline runner - orchestrates parsing and processors to produce frames.
 *
 * The pipeline is **lazy by design**:
 * - `push(chunk)` buffers tokens without processing
 * - `pull()` parses buffered content and runs processors
 * - Consumers control when processing happens (backpressure)
 *
 * This enables efficient batching - tokens accumulate between pulls,
 * reducing the number of processor invocations.
 *
 * ## Usage Patterns
 *
 * **React (RAF-paced):**
 * ```typescript
 * const pipeline = createPipeline(config)
 *
 * // Push tokens as they arrive (fast, just buffers)
 * onToken(token => pipeline.push(token))
 *
 * // Pull frames at RAF rate
 * function animate() {
 *   const frame = yield* pipeline.pull()
 *   setFrame(frame)
 *   if (!done) requestAnimationFrame(animate)
 * }
 * ```
 *
 * **TUI (fixed interval):**
 * ```typescript
 * while (streaming) {
 *   yield* sleep(33) // ~30fps
 *   const frame = yield* pipeline.pull()
 *   render(frame)
 * }
 * ```
 *
 * **TTS (on-demand):**
 * ```typescript
 * while (streaming) {
 *   yield* waitForSpeechBufferLow()
 *   const frame = yield* pipeline.pull()
 *   queueSpeech(frame)
 * }
 * ```
 */
import type { Operation, Channel, Subscription } from 'effection'
import type {
  Frame,
  Processor,
  ProcessorPreset,
  PipelineConfig,
  ParseContext,
  ProcessFn,
} from './types'
import { emptyFrame } from './frame'
import { createParser } from './parser'
import { resolveProcessors } from './resolver'

// Import built-in processors to ensure they register themselves
import { markdown } from './processors/markdown'
import { shiki } from './processors/shiki'
import { mermaid } from './processors/mermaid'
import { math } from './processors/math'

// =============================================================================
// Presets
// =============================================================================

/**
 * Resolve a preset name to an array of processors.
 */
function resolvePreset(preset: ProcessorPreset): readonly Processor[] {
  switch (preset) {
    case 'markdown':
      return [markdown]
    case 'shiki':
      return [markdown, shiki]
    case 'mermaid':
      return [markdown, mermaid]
    case 'math':
      return [markdown, math]
    case 'full':
      return [markdown, shiki, mermaid, math]
  }
}

// =============================================================================
// Pipeline Instance
// =============================================================================

/**
 * A lazy pipeline instance.
 *
 * Tokens are pushed in (buffered), frames are pulled out (processed on-demand).
 * This enables backpressure - consumers control processing rate.
 */
export interface Pipeline {
  /** Current frame state (last pulled frame, or empty if never pulled) */
  readonly frame: Frame

  /** Whether there's buffered content that hasn't been processed yet */
  readonly hasPending: boolean

  /** Whether the stream has ended (flush was called) */
  readonly isDone: boolean

  /**
   * Push a chunk of raw content into the buffer.
   * This is synchronous and does NOT trigger processing.
   */
  push(chunk: string): void

  /**
   * Pull the next frame by processing all buffered content.
   * Runs parser + all processors on accumulated buffer.
   * Returns the same frame if nothing new was buffered.
   */
  pull(): Operation<Frame>

  /**
   * Signal end of stream and pull final frame.
   * After this, hasPending will be false and isDone will be true.
   */
  flush(): Operation<Frame>

  /**
   * Reset the pipeline for a new stream.
   */
  reset(): void
}

/**
 * Internal configuration after resolving presets and dependencies.
 */
interface ResolvedConfig {
  processFns: readonly ProcessFn[]
}

/**
 * Resolve a PipelineConfig to process functions.
 */
function resolveConfig(config: PipelineConfig): ResolvedConfig {
  // Handle preset string
  if (typeof config.processors === 'string') {
    const processors = resolvePreset(config.processors)
    const resolved = resolveProcessors(processors)
    return {
      processFns: resolved.processors.map(p => p.process),
    }
  }

  // Handle array of processors
  const processors = config.processors
  if (processors.length === 0) {
    return { processFns: [] }
  }

  const resolved = resolveProcessors(processors)
  return {
    processFns: resolved.processors.map(p => p.process),
  }
}

/**
 * Create a lazy pipeline instance.
 *
 * @param config - Pipeline configuration (processors or preset)
 */
export function createPipeline(config: PipelineConfig): Pipeline {
  // Resolve config
  const resolved = resolveConfig(config)

  // Create parser (internal) - maintains fence state across chunks
  const parser = createParser()

  // Get process functions
  const processFns = resolved.processFns

  // Pipeline state
  let currentFrame = emptyFrame()
  let buffer = ''
  let isDone = false

  const instance: Pipeline = {
    get frame() {
      return currentFrame
    },

    get hasPending() {
      return buffer.length > 0
    },

    get isDone() {
      return isDone
    },

    push(chunk: string): void {
      if (isDone) {
        throw new Error('Cannot push to a finished pipeline. Call reset() first.')
      }
      buffer += chunk
    },

    *pull(): Operation<Frame> {
      // Nothing to process
      if (buffer.length === 0) {
        return currentFrame
      }

      // Step 1: Parse buffered content into block structure
      const ctx: ParseContext = { flush: false }
      const chunkToProcess = buffer
      buffer = '' // Clear buffer before processing

      const parsedFrame = parser(currentFrame, chunkToProcess, ctx)

      // If parser changed the frame, run processors
      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame

        // Step 2: Run processors in sequence
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame)
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame
          }
        }
      }

      return currentFrame
    },

    *flush(): Operation<Frame> {
      if (isDone) {
        return currentFrame
      }

      // Process any remaining buffer first
      if (buffer.length > 0) {
        yield* instance.pull()
      }

      // Parse with flush=true to handle any incomplete content
      const ctx: ParseContext = { flush: true }
      const parsedFrame = parser(currentFrame, '', ctx)

      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame

        // Run processors on flushed frame
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame)
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame
          }
        }
      }

      isDone = true
      return currentFrame
    },

    reset(): void {
      currentFrame = emptyFrame()
      buffer = ''
      isDone = false
    },
  }

  return instance
}

// =============================================================================
// Compose Process Functions
// =============================================================================

/**
 * Compose multiple process functions into one.
 * Functions run in sequence, each receiving the output of the previous.
 */
export function composeProcessFns(fns: ProcessFn[]): ProcessFn {
  return function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame

    for (const fn of fns) {
      currentFrame = yield* fn(currentFrame)
    }

    return currentFrame
  }
}

// =============================================================================
// Pipeline Transform (for integration with existing system)
// =============================================================================

// Import patch types
import type { ChatPatch } from '../types'
import type { ContentPartType, PartFramePatch, PartEndPatch } from '../../../lib/chat/patches'
import { generatePartId } from '../../../lib/chat/types/chat-message'

/**
 * Create a patch transform from a pipeline config.
 *
 * This bridges the lazy pipeline with the existing patch-based
 * streaming infrastructure.
 *
 * ## Per-Segment Pipelines
 *
 * The transform manages a separate pipeline for each content segment:
 * - streaming_text → text segment
 * - streaming_reasoning → reasoning segment
 *
 * When content type switches (reasoning → text, text → tool_call), the
 * current pipeline is flushed and a `part_end` patch is emitted. A new
 * pipeline is created for the next segment.
 *
 * ## Patches Emitted
 *
 * - `part_frame` - Frame update for the current part
 * - `part_end` - Part finalized with its final frame
 *
 * Original patches (streaming_text, etc.) are passed through.
 */
export function createPipelineTransform(config: PipelineConfig) {
  return function* pipelineTransform(
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
    // Current segment state
    let currentPartType: ContentPartType | null = null
    let currentPartId: string | null = null
    let pipeline: Pipeline | null = null

    /**
     * Flush the current segment and emit part_end.
     */
    function* flushCurrentSegment(): Operation<void> {
      if (!pipeline || !currentPartId || !currentPartType) {
        return
      }

      const frame = yield* pipeline.flush()

      const partEndPatch: PartEndPatch = {
        type: 'part_end',
        partType: currentPartType,
        partId: currentPartId,
        frame,
      }
      yield* output.send(partEndPatch)

      // Reset segment state
      pipeline = null
      currentPartId = null
      currentPartType = null
    }

    /**
     * Start a new segment with the given type.
     */
    function startNewSegment(partType: ContentPartType): void {
      currentPartType = partType
      currentPartId = generatePartId()
      pipeline = createPipeline(config)
    }

    /**
     * Push content and emit part_frame for the current segment.
     */
    function* pushAndEmitFrame(content: string): Operation<void> {
      if (!pipeline || !currentPartId || !currentPartType) {
        return
      }

      pipeline.push(content)

      if (pipeline.hasPending) {
        const frame = yield* pipeline.pull()

        const partFramePatch: PartFramePatch = {
          type: 'part_frame',
          partType: currentPartType,
          partId: currentPartId,
          frame,
        }
        yield* output.send(partFramePatch)
      }
    }

    /**
     * Handle content streaming (text or reasoning).
     */
    function* handleContentPatch(
      content: string,
      partType: ContentPartType
    ): Operation<void> {
      // If content type changed, flush previous segment
      if (currentPartType !== null && currentPartType !== partType) {
        yield* flushCurrentSegment()
      }

      // Start new segment if needed
      if (currentPartType !== partType) {
        startNewSegment(partType)
      }

      // Push content and emit frame
      yield* pushAndEmitFrame(content)
    }

    // Subscribe to input
    const subscription: Subscription<ChatPatch, void> = yield* input

    // Process patches
    while (true) {
      const next = yield* subscription.next()

      if (next.done) {
        // Stream ended - flush current segment
        yield* flushCurrentSegment()
        break
      }

      const patch = next.value

      if (patch.type === 'streaming_start') {
        // Reset for new stream
        yield* flushCurrentSegment()
        yield* output.send(patch)
      } else if (patch.type === 'streaming_text') {
        // Handle text content
        yield* handleContentPatch(patch.content, 'text')
        // Pass through original patch
        yield* output.send(patch)
      } else if (patch.type === 'streaming_reasoning' || patch.type === 'streaming_thinking') {
        // Handle reasoning content
        yield* handleContentPatch(patch.content, 'reasoning')
        // Pass through original patch
        yield* output.send(patch)
      } else if (patch.type === 'tool_call_start') {
        // Tool calls interrupt content - flush current segment
        yield* flushCurrentSegment()
        yield* output.send(patch)
      } else if (patch.type === 'streaming_end') {
        // Flush current segment
        yield* flushCurrentSegment()
        yield* output.send(patch)
      } else {
        // Pass through other patches unchanged
        yield* output.send(patch)
      }
    }
  }
}

// =============================================================================
// Simple Runner (for testing)
// =============================================================================

/**
 * Run a pipeline on a complete string (for testing).
 *
 * @param content - Full content to process
 * @param config - Pipeline configuration
 * @returns Final frame
 */
export function* runPipeline(
  content: string,
  config: PipelineConfig
): Operation<Frame> {
  const pipeline = createPipeline(config)

  // Push all content
  pipeline.push(content)

  // Pull and flush
  yield* pipeline.pull()
  return yield* pipeline.flush()
}

/**
 * Run a pipeline simulating streaming (for testing).
 * Pushes content line by line and pulls after each.
 */
export function* runPipelineStreaming(
  content: string,
  config: PipelineConfig
): Operation<{ frames: Frame[]; final: Frame }> {
  const frames: Frame[] = []
  const pipeline = createPipeline(config)

  // Process content line by line
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const isLast = i === lines.length - 1
    const chunk = isLast ? line : line + '\n'

    if (chunk) {
      pipeline.push(chunk)
      const frame = yield* pipeline.pull()
      frames.push(frame)
    }
  }

  // Flush
  const final = yield* pipeline.flush()
  frames.push(final)

  return { frames, final }
}
