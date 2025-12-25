/**
 * mermaid/index.ts
 * 
 * Progressive mermaid diagram rendering with streaming support.
 * 
 * Exports:
 * - mermaidProcessor: Processor with quick highlight → SVG render
 * - quickMermaidProcessor: Quick-only processor (no rendering)
 * - renderMermaid: Direct mermaid operation for custom use
 * - preloadMermaid: Preload mermaid for faster first render
 */

// Processors
export { mermaidProcessor, quickMermaidProcessor } from './processor'

// Loader utilities
export { 
  renderMermaid, 
  preloadMermaid, 
  isMermaidReady,
  type MermaidRenderResult,
} from './loader'
