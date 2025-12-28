/**
 * pipeline/runner.ts
 *
 * Pipeline runner - orchestrates settler and processors to produce frames.
 *
 * The runner:
 * 1. Receives raw streaming chunks
 * 2. Passes them through the settler (creates block structure)
 * 3. Runs processors in sequence (enhances blocks with HTML)
 * 4. Emits frames for the UI to render
 *
 * ## Progressive Enhancement
 *
 * The runner supports progressive enhancement by emitting multiple frames:
 * - After settler: Frame with block structure (raw content only)
 * - After each processor: Frame with enhanced HTML
 *
 * This allows the UI to show immediate feedback while async processors
 * (like Shiki/Mermaid) complete in the background.
 */
import type { Operation, Channel, Subscription } from 'effection'
import { spawn } from 'effection'
import type {
  Frame,
  Settler,
  SettlerFactory,
  Processor,
  ProcessorFactory,
  SettleContext,
  PipelineConfig,
  FrameEmitter,
} from './types'
import { emptyFrame, renderFrameToHtml, renderFrameToRaw, addTrace } from './frame'

// =============================================================================
// Pipeline Instance
// =============================================================================

/**
 * A pipeline instance manages state for a single streaming session.
 */
export interface PipelineInstance {
  /** Current frame state */
  readonly frame: Frame

  /** Process a chunk of raw content */
  process(chunk: string, ctx: SettleContext): Operation<Frame>

  /** Flush any remaining content (end of stream) */
  flush(): Operation<Frame>

  /** Reset the pipeline for a new stream */
  reset(): void
}

/**
 * Create a pipeline instance.
 *
 * @param config - Pipeline configuration
 * @param onFrame - Optional callback for each frame produced
 */
export function createPipeline(
  config: PipelineConfig,
  onFrame?: FrameEmitter
): PipelineInstance {
  // Create instances from factories
  const settler = config.settler()
  const processors = config.processors.map((f) => f())

  // Current state
  let currentFrame = emptyFrame()

  const instance: PipelineInstance = {
    get frame() {
      return currentFrame
    },

    *process(chunk: string, ctx: SettleContext): Operation<Frame> {
      // Step 1: Run settler to update block structure
      const settledFrame = settler(currentFrame, chunk, ctx)

      // If settler changed the frame, run processors
      if (settledFrame !== currentFrame) {
        currentFrame = settledFrame

        // Step 2: Run processors in sequence
        for (const processor of processors) {
          const processedFrame = yield* processor(currentFrame)

          // If processor changed the frame, update and optionally emit
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame

            if (onFrame) {
              yield* onFrame(currentFrame)
            }
          }
        }

        // Emit final frame if we have a callback and haven't emitted yet
        if (onFrame && processors.length === 0) {
          yield* onFrame(currentFrame)
        }
      }

      return currentFrame
    },

    *flush(): Operation<Frame> {
      // Process with flush=true to handle any remaining content
      return yield* this.process('', { pending: '', flush: true })
    },

    reset(): void {
      currentFrame = emptyFrame()
    },
  }

  return instance
}

// =============================================================================
// Compose Processors
// =============================================================================

/**
 * Compose multiple processors into a single processor.
 * Processors run in sequence, each receiving the output of the previous.
 */
export function composeProcessors(processors: Processor[]): Processor {
  return function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame

    for (const processor of processors) {
      currentFrame = yield* processor(currentFrame)
    }

    return currentFrame
  }
}

// =============================================================================
// Pipeline Transform (for integration with existing system)
// =============================================================================

/**
 * Create a patch transform from a pipeline config.
 *
 * This bridges the new pipeline system with the existing patch-based
 * streaming infrastructure. It receives streaming patches and emits
 * buffer_renderable patches with Frame-based rendering.
 */
export function createPipelineTransform(config: PipelineConfig) {
  return function* pipelineTransform(
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
    let lastHtml = ''
    let lastRaw = ''

    // Create pipeline instance with frame emission
    const pipeline = createPipeline(config, function* (frame) {
      const html = renderFrameToHtml(frame)
      const raw = renderFrameToRaw(frame)

      // Emit buffer_renderable patch with frame data
      const patch: BufferRenderablePatch = {
        type: 'buffer_renderable',
        prev: lastRaw,
        next: raw,
        html,
        delta: {
          added: raw.slice(lastRaw.length),
          startOffset: lastRaw.length,
        },
        timestamp: Date.now(),
      }

      yield* output.send(patch)

      lastHtml = html
      lastRaw = raw
    })

    // Subscribe to input
    const subscription: Subscription<ChatPatch, void> = yield* input

    // Process patches
    while (true) {
      const next = yield* subscription.next()

      if (next.done) {
        // Stream ended - flush any remaining content
        yield* pipeline.flush()
        break
      }

      const patch = next.value

      if (patch.type === 'streaming_start') {
        // Reset pipeline for new stream
        pipeline.reset()
        lastHtml = ''
        lastRaw = ''
        yield* output.send(patch)
      } else if (patch.type === 'streaming_text') {
        // Process chunk through pipeline
        yield* pipeline.process(patch.content, { pending: '', flush: false })
        // Pass through original patch for raw buffer tracking
        yield* output.send(patch)
      } else if (patch.type === 'streaming_end') {
        // Flush any remaining content
        yield* pipeline.flush()
        yield* output.send(patch)
      } else {
        // Pass through other patches unchanged
        yield* output.send(patch)
      }
    }
  }
}

// Import patch types from the main types
import type { ChatPatch, BufferRenderablePatch } from '../types'

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

  // Process content line by line (simulating streaming)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const isLast = i === lines.length - 1
    const chunk = isLast ? line : line + '\n'

    if (chunk) {
      yield* pipeline.process(chunk, { pending: '', flush: false })
    }
  }

  // Flush any remaining content
  yield* pipeline.flush()

  return pipeline.frame
}

/**
 * Run a pipeline and collect all intermediate frames (for testing).
 */
export function* runPipelineWithFrames(
  content: string,
  config: PipelineConfig
): Operation<{ frames: Frame[]; final: Frame }> {
  const frames: Frame[] = []

  const pipeline = createPipeline(config, function* (frame) {
    frames.push(frame)
  })

  // Process content line by line
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const isLast = i === lines.length - 1
    const chunk = isLast ? line : line + '\n'

    if (chunk) {
      yield* pipeline.process(chunk, { pending: '', flush: false })
    }
  }

  // Flush
  yield* pipeline.flush()

  return { frames, final: pipeline.frame }
}
