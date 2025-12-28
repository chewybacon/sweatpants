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
 * Tokens → Settler → Frame₀ → [Processors] → Frame₁ → UI
 * ```
 *
 * - **Settler**: Parses raw tokens into block structure
 * - **Processors**: Transform frames (enhance blocks with HTML)
 * - **Frames**: Immutable snapshots that UI can render/animate between
 *
 * ## Progressive Enhancement
 *
 * Frames support progressive enhancement via `renderPass`:
 * - 'quick': Fast initial render (regex highlighting, escaped code)
 * - 'full': Complete render (Shiki, Mermaid SVG, etc.)
 *
 * The UI receives both frames and can animate between them.
 */
import type { Operation } from 'effection'

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
 * Frames are the core unit of the pipeline - settlers create them,
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
   * Used by settlers to know which block to append to.
   */
  readonly activeBlockIndex: number | null
}

// =============================================================================
// Settler Types
// =============================================================================

/**
 * Context provided to settler on each chunk.
 */
export interface SettleContext {
  /** Any pending content not yet processed */
  readonly pending: string

  /** True when this is the final flush at stream end */
  readonly flush: boolean
}

/**
 * A Settler parses raw tokens and updates the Frame's block structure.
 *
 * Settlers are responsible for:
 * - Creating new blocks (text/code)
 * - Tracking code fence boundaries
 * - Determining when blocks are complete vs streaming
 *
 * Settlers should NOT do HTML rendering - that's the processors' job.
 *
 * @param frame - Current frame state
 * @param chunk - New raw content to process
 * @param ctx - Additional context (pending buffer, flush flag)
 * @returns Updated frame with new/modified blocks
 */
export type Settler = (frame: Frame, chunk: string, ctx: SettleContext) => Frame

/**
 * Factory function to create a fresh Settler.
 * Allows settlers to maintain internal state (like fence tracking).
 */
export type SettlerFactory = () => Settler

// =============================================================================
// Processor Types
// =============================================================================

/**
 * A Processor transforms a Frame, typically by enhancing block HTML.
 *
 * Processors are pure functions (given same input, produce same output).
 * They can be async (return Operation) for things like Shiki highlighting.
 *
 * Processors should:
 * - Only modify blocks they care about
 * - Leave other blocks unchanged (natural passthrough)
 * - Add trace entries for debugging
 * - Be idempotent (running twice should be safe)
 *
 * @param frame - Current frame state
 * @returns Updated frame (or same frame if no changes)
 */
export type Processor = (frame: Frame) => Operation<Frame>

/**
 * Factory function to create a fresh Processor.
 * Allows processors to maintain internal state if needed.
 */
export type ProcessorFactory = () => Processor

// =============================================================================
// Pipeline Types
// =============================================================================

/**
 * Configuration for a processing pipeline.
 */
export interface PipelineConfig {
  /** Settler strategy for parsing raw content into blocks */
  readonly settler: SettlerFactory

  /** Ordered list of processors to run on each frame */
  readonly processors: readonly ProcessorFactory[]

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
