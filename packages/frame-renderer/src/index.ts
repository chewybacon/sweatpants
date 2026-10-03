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
 * import { createPipeline, markdown, math } from '@sweatpants/frame-renderer'
 *
 * const pipeline = createPipeline({ processors: [markdown, math] })
 * pipeline.push('Hello **world**.\n') // buffers without rendering
 * const frame = yield* pipeline.pull() // consumer decides when to render
 * pipeline.push('More content')
 * const finalFrame = yield* pipeline.flush() // settles the remaining text
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
  NodeSyntax,
  SyntaxRule,
  SyntaxMatch,
  NodeRendererDefinition,
  NodeRenderResult,
  FenceContent,
  FenceRenderResult,
  FenceRendererDefinition,
  ProcessFn,
  ProcessorPreset,

  // Pipeline types
  PipelineConfig,
  PipelineResult,
  ResolvedProcessors,
} from "./types.ts";

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
} from "./frame.ts";

// =============================================================================
// Built-in Processors
// =============================================================================

export { markdown } from "./processors/markdown.ts";
export { shiki, preloadShiki, isShikiReady } from "./processors/shiki.ts";
export { mermaid, preloadMermaid, isMermaidReady } from "./processors/mermaid.ts";
export { math, preloadMath, isMathReady } from "./processors/math.ts";

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
} from "./resolver.ts";

// =============================================================================
// Pipeline Runner
// =============================================================================

export type { Pipeline } from "./runner.ts";

export { createPipeline, composeProcessFns, runPipeline, runPipelineStreaming } from "./runner.ts";
export { getFrameNodes, type RenderNode } from "./document.ts";
export { defineInlineSyntax, defineNodeSyntax } from "./syntax.ts";
export { defineNodeRenderer } from "./node-renderer.ts";
export { mathSyntax, type MathContent } from "./math-syntax.ts";

export { defineFenceRenderer } from "./fence-renderer.ts";
