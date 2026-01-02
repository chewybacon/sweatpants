/**
 * pipeline/index.ts
 *
 * Frame-based streaming pipeline for progressive content rendering.
 *
 * ## Overview
 *
 * The pipeline processes streaming AI content through:
 *
 * 1. **Parser**: Internal - parses raw tokens into block structure (text/code)
 * 2. **Processors**: User-defined - enhance blocks with HTML (markdown, highlighting, diagrams)
 * 3. **Frames**: Immutable snapshots of the document state
 *
 * ```
 * Tokens → Parser → Frame₀ → [Processors] → Frame₁ → UI
 * ```
 *
 * ## Progressive Enhancement
 *
 * Frames support progressive enhancement:
 * - Quick pass: Fast initial render (regex highlighting)
 * - Full pass: Complete render (Shiki, Mermaid SVG)
 *
 * The UI receives both and can animate between them.
 *
 * ## Example
 *
 * ```typescript
 * import { markdown, shiki, mermaid } from '@tanstack/framework/react/chat/pipeline'
 *
 * // Simple - just list processors, dependencies auto-resolved
 * useChat({
 *   processors: [markdown, shiki, mermaid]
 * })
 *
 * // Or use a preset
 * useChat({
 *   processors: 'full'  // = [markdown, shiki, mermaid, math]
 * })
 * ```
 */

// =============================================================================
// Core Types
// =============================================================================

export type {
  // Annotation types
  Annotation,

  // Block types
  Block,
  BlockType,
  BlockStatus,
  RenderPass,

  // Frame types
  Frame,
  TraceEntry,
  TraceAction,

  // Processor types
  Processor,
  ProcessFn,
  ProcessorPreset,

  // Pipeline types
  PipelineConfig,
  PipelineResult,
  ResolvedProcessors,
} from './types'

// =============================================================================
// Frame Utilities
// =============================================================================

export {
  // ID generation
  generateFrameId,
  generateBlockId,
  resetIdCounters,

  // Frame creation
  emptyFrame,
  updateFrame,

  // Block creation
  createBlock,
  createTextBlock,
  createCodeBlock,

  // Block updates
  updateBlock,
  appendToBlock,
  completeBlock,
  setBlockRendered,
  addAnnotation,
  addAnnotations,

  // Frame block operations
  addBlock,
  updateBlockAt,
  updateBlockById,
  updateActiveBlock,
  getActiveBlock,
  getLastBlock,
  setActiveBlock,
  clearActiveBlock,

  // Trace operations
  addTrace,
  createTrace,

  // Frame queries
  hasBlocks,
  hasStreamingBlocks,
  getBlocksByType,
  getCodeBlocks,
  getTextBlocks,
  findBlockById,
  getBlocksNeedingRender,

  // Frame rendering
  renderFrameToRendered,
  renderFrameToRaw,
} from './frame'

// =============================================================================
// Built-in Processors
// =============================================================================

export { markdown } from './processors/markdown'
export { shiki, preloadShiki, isShikiReady } from './processors/shiki'
export { mermaid, preloadMermaid, isMermaidReady } from './processors/mermaid'
export { math, preloadMath, isMathReady } from './processors/math'

// =============================================================================
// Processor Resolution
// =============================================================================

export {
  resolveProcessors,
  preloadProcessors,
  areProcessorsReady,
  loadProcessors,
  // Errors
  ProcessorResolutionError,
  CircularDependencyError,
  MissingDependencyError,
  DuplicateProcessorError,
} from './resolver'

// =============================================================================
// Pipeline Runner
// =============================================================================

export type { Pipeline } from './runner'

export {
  createPipeline,
  composeProcessFns,
  createPipelineTransform,
  runPipeline,
  runPipelineStreaming,
} from './runner'
