/**
 * pipeline/types.ts
 *
 * Core types for the Frame-based streaming pipeline.
 *
 * ## Design Philosophy
 *
 * The pipeline treats document rendering as a series of immutable Frame snapshots.
 * Each frame represents the complete document state at a point in time.
 *
 * ```
 * Tokens → Parser → Frame₀ → [Processors] → Frame₁ → UI
 * ```
 *
 * - **Parser**: Internal - parses raw tokens into block structure (code fences)
 * - **Processors**: User-defined - transform frames (enhance blocks with HTML)
 * - **Frames**: Immutable snapshots that UI can render/animate between
 *
 * ## Progressive Enhancement
 *
 * Frames support progressive enhancement via `renderPass`:
 * - 'quick': Fast initial render (regex highlighting, escaped code)
 * - 'full': Complete render (Shiki, Mermaid SVG, etc.)
 *
 * The UI receives frames and can animate between render passes.
 *
 * ## Annotations
 *
 * Blocks can carry annotations - metadata extracted by processors that
 * doesn't affect visual rendering but can be consumed by other systems
 * (e.g., TTS directives, math positions, link targets).
 */
import type { Operation } from 'effection'

// =============================================================================
// Annotation Types
// =============================================================================

/**
 * An annotation is metadata extracted from content by a processor.
 *
 * Annotations don't affect visual rendering but can be consumed by
 * other systems (TTS, accessibility, analytics, etc.).
 *
 * @example
 * // Math annotation
 * { type: 'math', subtype: 'inline', rawStart: 6, rawEnd: 11, data: { latex: 'x^2' } }
 *
 * // TTS directive annotation
 * { type: 'directive', subtype: 'pause', rawStart: 18, rawEnd: 25, data: { duration: 500 } }
 */
export interface Annotation {
  /** Annotation category (e.g., 'math', 'directive', 'link') */
  readonly type: string

  /** Annotation subtype (e.g., 'inline', 'block', 'pause', 'laugh') */
  readonly subtype?: string

  /** Start position in block.raw */
  readonly rawStart: number

  /** End position in block.raw */
  readonly rawEnd: number

  /** Start position in block.html (if tracked) */
  readonly renderedStart?: number

  /** End position in block.html (if tracked) */
  readonly renderedEnd?: number

  /** Type-specific payload */
  readonly data?: Readonly<Record<string, unknown>>
}

// =============================================================================
// Block Types
// =============================================================================

/**
 * Render quality level for a block.
 *
 * - 'none': No HTML yet (just raw content)
 * - 'quick': Fast initial render (regex highlighting, basic escaping)
 * - 'full': Complete high-quality render (Shiki, Mermaid SVG, etc.)
 */
export type RenderPass = 'none' | 'quick' | 'full'

/**
 * Block processing status.
 *
 * - 'streaming': Block is still receiving content
 * - 'complete': Block content is finalized
 */
export type BlockStatus = 'streaming' | 'complete'

/**
 * Block type discriminator.
 */
export type BlockType = 'text' | 'code'

/**
 * A block of content in the document.
 *
 * Blocks are immutable - updates create new block instances.
 * Each block has raw content and optional rendered HTML.
 */
export interface Block {
  /** Stable identifier for tracking across frames */
  readonly id: string

  /** Block type: 'text' for prose, 'code' for fenced code */
  readonly type: BlockType

  /** Raw source content (markdown text or code) */
  readonly raw: string

  /** Rendered HTML (empty string if not yet rendered) */
  readonly html: string

  /** Processing status */
  readonly status: BlockStatus

  /** Current render quality */
  readonly renderPass: RenderPass

  /** Language identifier for code blocks */
  readonly language?: string

  /**
   * Annotations extracted by processors.
   * These don't affect visual rendering but can be consumed by other systems.
   */
  readonly annotations?: readonly Annotation[]

  /**
   * Extensible metadata for processors.
   * Processors can attach arbitrary data here.
   */
  readonly meta?: Readonly<Record<string, unknown>>
}

// =============================================================================
// Frame Types
// =============================================================================

/**
 * What action a processor took on a block.
 */
export type TraceAction = 'create' | 'update' | 'skip' | 'error'

/**
 * Debug/logging entry for what happened during processing.
 */
export interface TraceEntry {
  /** Which processor produced this entry */
  readonly processor: string

  /** What action was taken */
  readonly action: TraceAction

  /** Which block was affected (if any) */
  readonly blockId?: string

  /** Human-readable detail */
  readonly detail?: string

  /** How long the operation took (ms) */
  readonly durationMs?: number

  /** Timestamp when this entry was created */
  readonly timestamp: number
}

/**
 * A Frame is an immutable snapshot of the document at a point in time.
 *
 * Frames are the core unit of the pipeline - the parser creates them,
 * processors transform them, and the UI renders them.
 */
export interface Frame {
  /** Unique frame identifier (for debugging) */
  readonly id: string

  /** Ordered list of content blocks */
  readonly blocks: readonly Block[]

  /** When this frame was created */
  readonly timestamp: number

  /** Processing trace for debugging */
  readonly trace: readonly TraceEntry[]

  /**
   * Index of the currently streaming block, or null if none.
   * Used by parser to know which block to append to.
   */
  readonly activeBlockIndex: number | null
}

// =============================================================================
// Processor Types
// =============================================================================

/**
 * The core processing function - transforms a Frame.
 *
 * Process functions are pure (given same input, produce same output).
 * They can be async (return Operation) for things like Shiki highlighting.
 *
 * Process functions should:
 * - Only modify blocks they care about
 * - Leave other blocks unchanged (natural passthrough)
 * - Be idempotent (running twice should be safe)
 *
 * @param frame - Current frame state
 * @returns Updated frame (or same frame if no changes)
 */
export type ProcessFn = (frame: Frame) => Operation<Frame>

/**
 * A Processor is a self-contained processing unit with metadata.
 *
 * Processors declare:
 * - Their identity (name, description)
 * - Dependencies on other processors
 * - Async asset loading (preload, isReady)
 * - The actual processing logic
 *
 * The pipeline resolves dependencies and runs processors in the correct order.
 *
 * @example
 * ```typescript
 * const shikiProcessor: Processor = {
 *   name: 'shiki',
 *   description: 'Syntax highlighting with Shiki',
 *   dependencies: ['markdown'],
 *
 *   *preload() {
 *     yield* preloadHighlighter()
 *   },
 *
 *   isReady: () => isHighlighterReady(),
 *
 *   process: function* (frame) {
 *     // Transform code blocks...
 *     return updatedFrame
 *   },
 * }
 * ```
 */
export interface Processor {
  /**
   * Unique identifier for this processor.
   * Used for dependency resolution and tracing.
   */
  readonly name: string

  /**
   * Human-readable description.
   */
  readonly description?: string

  /**
   * Processors that must run before this one.
   *
   * The pipeline performs a topological sort based on dependencies.
   * If a dependency is missing, it will be auto-added if it's a known processor.
   *
   * @example
   * dependencies: ['markdown'] // Shiki needs markdown to run first
   */
  readonly dependencies?: readonly string[]

  /**
   * Preload async assets (highlighters, renderers, etc.)
   *
   * Called eagerly when the pipeline is initialized.
   * Runs in parallel with other processor preloads.
   */
  readonly preload?: () => Operation<void>

  /**
   * Check if this processor's assets are ready.
   *
   * Used to show loading states or defer full rendering.
   */
  readonly isReady?: () => boolean

  /**
   * The processing function.
   *
   * Transforms a Frame, typically by enhancing block HTML.
   * Should be stateless - all state lives in the Frame.
   */
  readonly process: ProcessFn
}

// =============================================================================
// Pipeline Types
// =============================================================================

/**
 * Preset names for common processor combinations.
 */
export type ProcessorPreset = 'markdown' | 'shiki' | 'mermaid' | 'full'

/**
 * Configuration for a processing pipeline.
 *
 * Users provide processors (or a preset), and the pipeline handles:
 * - Dependency resolution and ordering
 * - Internal parsing (code fence detection)
 * - Frame emission
 */
export interface PipelineConfig {
  /**
   * Processors to run on each frame.
   *
   * Can be:
   * - An array of Processor objects (dependencies auto-resolved)
   * - A preset name ('markdown', 'shiki', 'mermaid', 'full')
   */
  readonly processors: readonly Processor[] | ProcessorPreset

  /** Enable debug tracing */
  readonly debug?: boolean
}

/**
 * Callback invoked when a new frame is ready.
 */
export type FrameEmitter = (frame: Frame) => Operation<void>

/**
 * Result of running the pipeline on a chunk.
 */
export interface PipelineResult {
  /** The final frame after all processors */
  readonly frame: Frame

  /** Intermediate frames (for progressive enhancement) */
  readonly intermediateFrames: readonly Frame[]
}

// =============================================================================
// Internal Types (not part of public API)
// =============================================================================

/**
 * Context provided to parser on each chunk.
 * @internal
 */
export interface ParseContext {
  /** True when this is the final flush at stream end */
  readonly flush: boolean
}

/**
 * Internal parser function type.
 * @internal
 */
export type Parser = (frame: Frame, chunk: string, ctx: ParseContext) => Frame

/**
 * Factory to create a parser with internal state.
 * @internal
 */
export type ParserFactory = () => Parser

// =============================================================================
// Resolved Pipeline (internal)
// =============================================================================

/**
 * Result of resolving processors with dependencies.
 * @internal
 */
export interface ResolvedProcessors {
  /** Processors in dependency order */
  readonly processors: readonly Processor[]

  /** Any processors that were auto-added as dependencies */
  readonly addedDependencies: readonly string[]
}
