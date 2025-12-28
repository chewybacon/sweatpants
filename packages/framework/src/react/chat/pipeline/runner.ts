/**
 * pipeline/runner.ts
 *
 * Pipeline runner - orchestrates parsing and processors to produce frames.
 *
 * The runner:
 * 1. Receives raw streaming chunks
 * 2. Parses them into block structure (internal, automatic)
 * 3. Runs processors in dependency order (enhances blocks with HTML)
 * 4. Emits frames for the UI to render
 *
 * ## Progressive Enhancement
 *
 * The runner supports progressive enhancement by emitting multiple frames:
 * - After parsing: Frame with block structure (raw content only)
 * - After each processor: Frame with enhanced HTML
 *
 * This allows the UI to show immediate feedback while async processors
 * (like Shiki/Mermaid) complete in the background.
 */
import type { Operation, Channel, Subscription } from 'effection'
import type {
  Frame,
  Processor,
  ProcessorPreset,
  PipelineConfig,
  ParseContext,
  FrameEmitter,
  ProcessFn,
} from './types'
import { emptyFrame, renderFrameToHtml, renderFrameToRaw } from './frame'
import { createParser } from './parser'
import { resolveProcessors } from './resolver'

// Import built-in processors to ensure they register themselves
import { markdown } from './processors/markdown'
import { shiki } from './processors/shiki'
import { mermaid } from './processors/mermaid'

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
    case 'full':
      return [markdown, shiki, mermaid]
  }
}

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
  process(chunk: string): Operation<Frame>

  /** Flush any remaining content (end of stream) */
  flush(): Operation<Frame>

  /** Reset the pipeline for a new stream */
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
 * Create a pipeline instance.
 *
 * @param config - Pipeline configuration
 * @param onFrame - Optional callback for each frame produced
 */
export function createPipeline(
  config: PipelineConfig,
  onFrame?: FrameEmitter
): PipelineInstance {
  // Resolve config
  const resolved = resolveConfig(config)

  // Create parser (internal)
  const parser = createParser()

  // Get process functions
  const processFns = resolved.processFns

  // Current state
  let currentFrame = emptyFrame()

  const instance: PipelineInstance = {
    get frame() {
      return currentFrame
    },

    *process(chunk: string): Operation<Frame> {
      // Step 1: Parse chunk into block structure
      const ctx: ParseContext = { flush: false }
      const parsedFrame = parser(currentFrame, chunk, ctx)

      // If parser changed the frame, run processors
      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame

        // Step 2: Run processors in sequence
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame)

          // If processor changed the frame, update and optionally emit
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame

            if (onFrame) {
              yield* onFrame(currentFrame)
            }
          }
        }

        // Emit final frame if we have a callback and haven't emitted yet
        if (onFrame && processFns.length === 0) {
          yield* onFrame(currentFrame)
        }
      }

      return currentFrame
    },

    *flush(): Operation<Frame> {
      // Parse with flush=true to handle any remaining content
      const ctx: ParseContext = { flush: true }
      const parsedFrame = parser(currentFrame, '', ctx)

      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame

        // Run processors on flushed frame
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame)
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame
            if (onFrame) {
              yield* onFrame(currentFrame)
            }
          }
        }
      }

      return currentFrame
    },

    reset(): void {
      currentFrame = emptyFrame()
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

// Import patch types from the main types
import type { ChatPatch, BufferRenderablePatch } from '../types'

/**
 * Create a patch transform from a pipeline config.
 *
 * This bridges the pipeline system with the existing patch-based
 * streaming infrastructure. It receives streaming patches and emits
 * buffer_renderable patches with Frame-based rendering.
 */
export function createPipelineTransform(config: PipelineConfig) {
  return function* pipelineTransform(
    input: Channel<ChatPatch, void>,
    output: Channel<ChatPatch, void>
  ): Operation<void> {
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
        lastRaw = ''
        yield* output.send(patch)
      } else if (patch.type === 'streaming_text') {
        // Process chunk through pipeline
        yield* pipeline.process(patch.content)
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
      yield* pipeline.process(chunk)
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
      yield* pipeline.process(chunk)
    }
  }

  // Flush
  yield* pipeline.flush()

  return { frames, final: pipeline.frame }
}
