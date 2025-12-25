/**
 * shiki/index.ts
 * 
 * Progressive syntax highlighting with Shiki.
 * 
 * Exports:
 * - codeFence: Settler that detects code fences and yields with metadata
 * - shikiProcessor: Processor with quick→full highlighting
 * - quickHighlightProcessor: Quick-only processor (no Shiki)
 * - highlightCode: Direct Shiki operation for custom use
 * - preloadHighlighter: Preload Shiki for faster first highlight
 */

// Settlers
export { codeFence, line, type CodeFenceMeta } from './settlers'

// Processors
export { shikiProcessor, quickHighlightProcessor } from './processor'

// Loader utilities
export { 
  highlightCode, 
  preloadHighlighter, 
  isHighlighterReady,
  getLoadedLanguages,
} from './loader'
