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
 *   processors: 'full'  // = [markdown, shiki, mermaid]
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
  FrameEmitter,
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
  setBlockHtml,

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
  renderFrameToHtml,
  renderFrameToRaw,
} from './frame'

// =============================================================================
// Built-in Processors
// =============================================================================

// Canonical exports - use these
export { markdown } from './processors/markdown'
export { shiki, preloadShiki, isShikiReady } from './processors/shiki'
export { mermaid, preloadMermaid, isMermaidReady } from './processors/mermaid'

// Legacy exports for backward compatibility
export {
  createMarkdownProcessor,
  createStreamingMarkdownProcessor,
  markdownProcessor,
} from './processors/markdown'

export {
  createShikiProcessor,
  shikiProcessor,
} from './processors/shiki'

export {
  createMermaidProcessor,
  mermaidProcessor,
} from './processors/mermaid'

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

export type { PipelineInstance } from './runner'

export {
  createPipeline,
  composeProcessFns,
  createPipelineTransform,
  runPipeline,
  runPipelineWithFrames,
} from './runner'

// =============================================================================
// Legacy Exports (settlers - deprecated)
// =============================================================================

// These are deprecated - parsing is now internal
// Kept for backward compatibility during migration

/** @deprecated Parsing is now internal to the pipeline */
export { createCodeFenceSettler, createLineSettler, defaultSettler } from './settlers'

/** @deprecated Use Processor type instead */
export type { SettlerFactory, Settler, SettleContext } from './types'

// Note: Old ProcessorFactory type is replaced by the Processor interface
// which includes both metadata and the process function
