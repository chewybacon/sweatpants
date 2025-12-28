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
 *     pipeline: 'full'  // markdown + shiki + mermaid
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
 * - `'full'` - All processors (markdown + shiki + mermaid)
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

// --- Pipeline System (Recommended) ---
// Re-export specific items to avoid conflicts
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
  type FrameEmitter,
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
  setBlockHtml,
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
  renderFrameToHtml,
  renderFrameToRaw,
  // Processors
  markdown as pipelineMarkdown,
  shiki as pipelineShiki,
  mermaid as pipelineMermaid,
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
  type PipelineInstance,
  createPipeline,
  composeProcessFns,
  createPipelineTransform,
  runPipeline,
  runPipelineWithFrames,
} from './pipeline'

// --- Plugin System (Legacy - still supported) ---
export * from './plugins'

// --- Types ---
export * from './types'

// --- Core Infrastructure ---
export * from './core'
export * from './settlers'
export * from './processors'
export * from './processor-chain'

// --- Session & Streaming ---
export * from './session'
export * from './streamChatOnce'
export * from './transforms'
export * from './contexts'

// --- Additional Hooks ---
export * from './usePersonas'

// --- Buffer Transforms ---
export * from './dualBuffer'

// --- Namespaced Modules ---
// Shiki module - namespaced to avoid conflicts with settlers
export * as shiki from './shiki'
// Mermaid module - progressive diagram rendering
export * as mermaidLoader from './mermaid'
