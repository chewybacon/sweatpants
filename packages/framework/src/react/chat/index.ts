/**
 * @tanstack/framework/react/chat
 *
 * Streaming chat rendering with progressive enhancement.
 *
 * ## Recommended API (Pipeline-based)
 *
 * ```typescript
 * import { useChat } from '@tanstack/framework/react/chat'
 *
 * function Chat() {
 *   // Use a preset for common setups
 *   const { messages, send, isStreaming } = useChat({
 *     pipeline: 'full'  // markdown + shiki + mermaid + math
 *   })
 *   // ...
 * }
 * ```
 *
 * ## Pipeline Presets
 *
 * - `'markdown'` - Basic markdown parsing
 * - `'shiki'` - Markdown + syntax highlighting
 * - `'mermaid'` - Markdown + diagram rendering
 * - `'math'` - Markdown + KaTeX math rendering
 * - `'full'` - All processors (markdown + shiki + mermaid + math)
 *
 * ## Custom Processors
 *
 * ```typescript
 * import { markdown, shiki } from '@tanstack/framework/react/chat/pipeline'
 *
 * useChat({
 *   pipeline: { processors: [markdown, shiki] }
 * })
 * ```
 */

// --- Primary API ---
export * from './useChat'
export * from './useChatSession'
export * from './ChatProvider'

// --- Pipeline System ---
export {
  // Types
  type Annotation,
  type Block,
  type BlockType,
  type BlockStatus,
  type RenderPass,
  type Frame,
  type TraceEntry,
  type TraceAction,
  type Processor,
  type ProcessFn,
  type ProcessorPreset,
  type PipelineConfig,
  type PipelineResult,
  type ResolvedProcessors,
  // Frame utilities
  generateFrameId,
  generateBlockId,
  resetIdCounters,
  emptyFrame,
  updateFrame,
  createBlock,
  createTextBlock,
  createCodeBlock,
  updateBlock,
  appendToBlock,
  completeBlock,
  setBlockRendered,
  addBlock,
  updateBlockAt,
  updateBlockById,
  updateActiveBlock,
  getActiveBlock,
  getLastBlock,
  setActiveBlock,
  clearActiveBlock,
  addTrace,
  createTrace,
  hasBlocks,
  hasStreamingBlocks,
  getBlocksByType,
  getCodeBlocks,
  getTextBlocks,
  findBlockById,
  getBlocksNeedingRender,
  renderFrameToRendered,
  renderFrameToRaw,
  // Processors
  markdown,
  shiki,
  mermaid,
  preloadShiki,
  isShikiReady,
  preloadMermaid,
  isMermaidReady,
  // Resolver
  resolveProcessors,
  preloadProcessors,
  areProcessorsReady,
  loadProcessors,
  ProcessorResolutionError,
  // Runner
  type Pipeline,
  createPipeline,
  composeProcessFns,
  createPipelineTransform,
  runPipeline,
  runPipelineStreaming,
} from './pipeline'

// --- Types ---
export * from './types'

// --- Session & Streaming ---
export * from './session'
export * from './streamChatOnce'
// Note: transforms.ts contains channel transform infrastructure (not deprecated)
export * from './transforms'
export * from './contexts'

// --- Additional Hooks ---
export * from './usePersonas'
