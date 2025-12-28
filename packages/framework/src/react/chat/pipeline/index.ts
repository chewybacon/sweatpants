/**
 * pipeline/index.ts
 *
 * Frame-based streaming pipeline for progressive content rendering.
 *
 * ## Overview
 *
 * The pipeline processes streaming AI content through:
 *
 * 1. **Settler**: Parses raw tokens into block structure (text/code)
 * 2. **Processors**: Enhance blocks with HTML (markdown, syntax highlighting, diagrams)
 * 3. **Frames**: Immutable snapshots of the document state
 *
 * ```
 * Tokens → Settler → Frame₀ → [Processors] → Frame₁ → UI
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
 * import {
 *   createPipeline,
 *   createCodeFenceSettler,
 *   markdownProcessor,
 *   shikiProcessor,
 *   mermaidProcessor,
 *   renderFrameToHtml,
 * } from '@tanstack/framework/react/chat/pipeline'
 *
 * const pipeline = createPipeline({
 *   settler: createCodeFenceSettler,
 *   processors: [markdownProcessor, shikiProcessor, mermaidProcessor],
 * })
 *
 * // Process streaming content
 * for (const chunk of stream) {
 *   const frame = yield* pipeline.process(chunk, { pending: '', flush: false })
 *   const html = renderFrameToHtml(frame)
 *   updateUI(html)
 * }
 *
 * // Flush at end
 * const finalFrame = yield* pipeline.flush()
 * ```
 */

// =============================================================================
// Core Types
// =============================================================================

export type {
  // Block types
  Block,
  BlockType,
  BlockStatus,
  RenderPass,
  
  // Frame types
  Frame,
  TraceEntry,
  TraceAction,
  
  // Settler types
  Settler,
  SettlerFactory,
  SettleContext,
  
  // Processor types
  Processor,
  ProcessorFactory,
  
  // Pipeline types
  PipelineConfig,
  FrameEmitter,
  PipelineResult,
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
// Settlers
// =============================================================================

export {
  createCodeFenceSettler,
  createLineSettler,
  defaultSettler,
} from './settlers'

// =============================================================================
// Processors
// =============================================================================

export {
  createMarkdownProcessor,
  createStreamingMarkdownProcessor,
  markdownProcessor,
} from './processors/markdown'

export {
  createShikiProcessor,
  shikiProcessor,
  preloadShiki,
  isShikiReady,
} from './processors/shiki'

export {
  createMermaidProcessor,
  mermaidProcessor,
  preloadMermaid,
  isMermaidReady,
} from './processors/mermaid'

// =============================================================================
// Pipeline Runner
// =============================================================================

export type { PipelineInstance } from './runner'

export {
  createPipeline,
  composeProcessors,
  createPipelineTransform,
  runPipeline,
  runPipelineWithFrames,
} from './runner'
