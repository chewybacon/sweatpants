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
import type { Frame, Processor, ProcessorPreset, PipelineConfig, ProcessFn } from "./types.ts";
import { emptyFrame } from "./frame.ts";
import { createParser } from "./parser.ts";
import { resolveProcessors } from "./resolver.ts";

// Import built-in processors to ensure they register themselves
import { markdown, createMarkdownProcess } from "./processors/markdown.ts";
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
  /** Last fully published frame. Rendering never exposes partial processor output. */
  readonly frame: Frame;

  /** Whether input is queued or rendering is in flight. Parser-held partial lines need flush. */
  readonly hasPending: boolean;

  /** True after a flush successfully publishes its final frame. */
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
   * Concurrent pull/flush operations throw PipelineLifecycleError with code "busy".
   * Failed or cancelled rendering retains input for retry; processors may run again.
   */
  pull(): Operation<Frame>;

  /**
   * Signal end of stream and atomically publish the final frame.
   * Push is rejected while flushing. A failed/cancelled flush reopens input.
   * After this, hasPending will be false and isDone will be true.
   */
  flush(): Operation<Frame>;

  /**
   * Reset all input, parser, and published state for a new stream.
   * An old render cannot publish; if it resumes, it throws code "reset".
   * Reset invalidates work but does not cancel its caller-owned Effection scope.
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
  const processors =
    typeof config.processors === "string" ? resolvePreset(config.processors) : config.processors;
  const resolved = resolveProcessors(processors);
  const syntaxes = resolved.processors.flatMap((processor) =>
    processor.nodeRenderer ? [processor.nodeRenderer.syntax] : [],
  );
  if (syntaxes.length > 0 && !resolved.processors.includes(markdown)) {
    throw new Error("Node renderers require the built-in markdown processor");
  }
  return {
    processFns: resolved.processors.map((processor) =>
      processor === markdown ? createMarkdownProcess(syntaxes) : processor.process,
    ),
  };
}

/**
 * Create a lazy pipeline instance.
 *
 * @param config - Pipeline configuration (processors or preset)
 */
export function createPipeline(config: PipelineConfig): Pipeline {
  const { processFns } = resolveConfig(config);
  const freshState = () => ({
    frame: emptyFrame(),
    parser: createParser(),
    buffer: "",
    busy: false,
    closing: false,
    done: false,
  });
  let state = freshState();

  function* render(flush: boolean): Operation<Frame> {
    const owner = state;
    if (owner.busy) {
      throw new PipelineLifecycleError("busy", "A pull or flush is already rendering.");
    }
    if (owner.done || (!flush && owner.buffer.length === 0)) {
      return owner.frame;
    }

    owner.busy = true;
    owner.closing = flush;
    const chunk = owner.buffer;
    owner.buffer = "";
    const parser = owner.parser.fork();
    let committed = false;
    try {
      // Back buffer: neither parser state nor partially rendered frames are public.
      let next = parser(owner.frame, chunk, { flush });
      if (next !== owner.frame) {
        for (const process of processFns) {
          next = yield* process(next);
          if (state !== owner) {
            throw new PipelineLifecycleError("reset", "The pipeline was reset during rendering.");
          }
        }
      }
      owner.parser = parser;
      owner.frame = next;
      owner.done = flush;
      committed = true;
      return next;
    } finally {
      // Cancellation and thrown errors preserve arrival order for the next demand.
      // A reset discards the old generation, including its failed render's input.
      if (!committed && state === owner) {
        owner.buffer = chunk + owner.buffer;
      }
      owner.busy = false;
      owner.closing = false;
    }
  }

  return {
    get frame() {
      return state.frame;
    },
    get hasPending() {
      return state.busy || state.buffer.length > 0;
    },
    get isDone() {
      return state.done;
    },
    push(chunk: string): void {
      if (state.done || state.closing) {
        throw new Error("Cannot push to a closing or finished pipeline. Call reset() first.");
      }
      state.buffer += chunk;
    },
    pull: () => render(false),
    flush: () => render(true),
    reset(): void {
      state = freshState();
    },
  };
}

/** Invalid use of a pipeline's rendering lifecycle. */
export class PipelineLifecycleError extends Error {
  constructor(
    readonly code: "busy" | "reset",
    message: string,
  ) {
    super(message);
    this.name = "PipelineLifecycleError";
  }
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
