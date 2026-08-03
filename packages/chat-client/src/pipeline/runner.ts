/**
 * pipeline/runner.ts
 *
 * Lazy pipeline runner - orchestrates parsing and processors to produce frames.
 *
 * The pipeline is **lazy by design**:
 * - `push(chunk)` buffers tokens without processing
 * - `pull()` parses buffered content and runs processors
 * - Consumers control when processing happens (presentation pacing)
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
 * A speech consumer can pull after each demand event and queue the resulting
 * frame without changing parser or processor semantics.
 */
import type { Operation } from "effection";
import type {
  Frame,
  Processor,
  ProcessorPreset,
  PipelineConfig,
  ParseContext,
  ProcessFn,
} from "./types.ts";
import { emptyFrame } from "./frame.ts";
import { createParser } from "./parser.ts";
import { resolveProcessors } from "./resolver.ts";

// Import built-in processors to ensure they register themselves
import { markdown } from "./processors/markdown.ts";
import { shiki } from "./processors/shiki.ts";
import { mermaid } from "./processors/mermaid.ts";
import { math } from "./processors/math.ts";

// =============================================================================
// Presets
// =============================================================================

/**
 * Resolve a preset name to an array of processors.
 */
function resolvePreset(preset: ProcessorPreset): readonly Processor[] {
  switch (preset) {
    case "markdown":
      return [markdown];
    case "shiki":
      return [markdown, shiki];
    case "mermaid":
      return [markdown, mermaid];
    case "math":
      return [markdown, math];
    case "full":
      return [markdown, shiki, mermaid, math];
  }
}

// =============================================================================
// Pipeline Instance
// =============================================================================

/**
 * A lazy pipeline instance.
 *
 * Tokens are pushed in (buffered), frames are pulled out (processed on-demand).
 * This decouples processor cadence from token arrival.
 */
export interface Pipeline {
  /** Current frame state (last pulled frame, or empty if never pulled) */
  readonly frame: Frame;

  /** Whether there's buffered content that hasn't been processed yet */
  readonly hasPending: boolean;

  /** Whether the stream has ended (flush was called) */
  readonly isDone: boolean;

  /**
   * Push a chunk of raw content into the buffer.
   * This is synchronous and does NOT trigger processing.
   */
  push(chunk: string): void;

  /**
   * Pull the next frame by processing all buffered content.
   * Runs parser + all processors on accumulated buffer.
   * Returns the same frame if nothing new was buffered.
   */
  pull(): Operation<Frame>;

  /**
   * Signal end of stream and pull final frame.
   * After this, hasPending will be false and isDone will be true.
   */
  flush(): Operation<Frame>;

  /**
   * Reset the pipeline for a new stream.
   */
  reset(): void;
}

/**
 * Internal configuration after resolving presets and dependencies.
 */
interface ResolvedConfig {
  processFns: readonly ProcessFn[];
}

/**
 * Resolve a PipelineConfig to process functions.
 */
function resolveConfig(config: PipelineConfig): ResolvedConfig {
  // Handle preset string
  if (typeof config.processors === "string") {
    const processors = resolvePreset(config.processors);
    const resolved = resolveProcessors(processors);
    return {
      processFns: resolved.processors.map((p) => p.process),
    };
  }

  // Handle array of processors
  const processors = config.processors;
  if (processors.length === 0) {
    return { processFns: [] };
  }

  const resolved = resolveProcessors(processors);
  return {
    processFns: resolved.processors.map((p) => p.process),
  };
}

/**
 * Create a lazy pipeline instance.
 *
 * @param config - Pipeline configuration (processors or preset)
 */
export function createPipeline(config: PipelineConfig): Pipeline {
  // Resolve config
  const resolved = resolveConfig(config);

  // Create parser (internal) - maintains fence state across chunks
  const parser = createParser();

  // Get process functions
  const processFns = resolved.processFns;

  // Pipeline state
  let currentFrame = emptyFrame();
  let buffer = "";
  let isDone = false;

  const instance: Pipeline = {
    get frame() {
      return currentFrame;
    },

    get hasPending() {
      return buffer.length > 0;
    },

    get isDone() {
      return isDone;
    },

    push(chunk: string): void {
      if (isDone) {
        throw new Error("Cannot push to a finished pipeline. Call reset() first.");
      }
      buffer += chunk;
    },

    *pull(): Operation<Frame> {
      // Nothing to process
      if (buffer.length === 0) {
        return currentFrame;
      }

      // Step 1: Parse buffered content into block structure
      const ctx: ParseContext = { flush: false };
      const chunkToProcess = buffer;
      buffer = ""; // Clear buffer before processing

      const parsedFrame = parser(currentFrame, chunkToProcess, ctx);

      // If parser changed the frame, run processors
      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame;

        // Step 2: Run processors in sequence
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame);
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame;
          }
        }
      }

      return currentFrame;
    },

    *flush(): Operation<Frame> {
      if (isDone) {
        return currentFrame;
      }

      // Process any remaining buffer first
      if (buffer.length > 0) {
        yield* instance.pull();
      }

      // Parse with flush=true to handle any incomplete content
      const ctx: ParseContext = { flush: true };
      const parsedFrame = parser(currentFrame, "", ctx);

      if (parsedFrame !== currentFrame) {
        currentFrame = parsedFrame;

        // Run processors on flushed frame
        for (const processFn of processFns) {
          const processedFrame = yield* processFn(currentFrame);
          if (processedFrame !== currentFrame) {
            currentFrame = processedFrame;
          }
        }
      }

      isDone = true;
      return currentFrame;
    },

    reset(): void {
      currentFrame = emptyFrame();
      buffer = "";
      isDone = false;
    },
  };

  return instance;
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
    let currentFrame = frame;

    for (const fn of fns) {
      currentFrame = yield* fn(currentFrame);
    }

    return currentFrame;
  };
}

// =============================================================================
// Pipeline Transform (for integration with existing system)
// =============================================================================

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
export function* runPipeline(content: string, config: PipelineConfig): Operation<Frame> {
  const pipeline = createPipeline(config);

  // Push all content
  pipeline.push(content);

  // Pull and flush
  yield* pipeline.pull();
  return yield* pipeline.flush();
}

/**
 * Run a pipeline simulating streaming (for testing).
 * Pushes content line by line and pulls after each.
 */
export function* runPipelineStreaming(
  content: string,
  config: PipelineConfig,
): Operation<{ frames: Frame[]; final: Frame }> {
  const frames: Frame[] = [];
  const pipeline = createPipeline(config);

  // Process content line by line
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    const chunk = isLast ? line : line + "\n";

    if (chunk) {
      pipeline.push(chunk);
      const frame = yield* pipeline.pull();
      frames.push(frame);
    }
  }

  // Flush
  const final = yield* pipeline.flush();
  frames.push(final);

  return { frames, final };
}
