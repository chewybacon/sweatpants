/**
 * Terminal Pipeline
 *
 * Pipeline configuration for terminal-based rendering.
 * Uses ANSI codes instead of HTML for output.
 */
import { createPipeline } from '@tanstack/framework/react/chat/pipeline'
import type { PipelineConfig, PipelineInstance } from '@tanstack/framework/react/chat/pipeline'

// Processors
import { terminalMarkdown } from './processors/terminal-markdown.ts'
import { terminalCode } from './processors/terminal-code.ts'

// =============================================================================
// Terminal Pipeline Configuration
// =============================================================================

/**
 * Default terminal processors.
 * Order matters - markdown runs first, then code highlighting.
 */
export const terminalProcessors = [
  terminalMarkdown,
  terminalCode,
]

/**
 * Create a terminal pipeline instance.
 *
 * @param onFrame - Optional callback for each frame produced
 */
export function createTerminalPipeline(
  onFrame?: Parameters<typeof createPipeline>[1]
): PipelineInstance {
  const config: PipelineConfig = {
    processors: terminalProcessors,
  }

  return createPipeline(config, onFrame)
}

// =============================================================================
// Re-exports
// =============================================================================

export { terminalMarkdown } from './processors/terminal-markdown.ts'
export { terminalCode, DEFAULT_THEME } from './processors/terminal-code.ts'

// Renderer components
export { FrameRenderer, frameToPlainText, frameToAnsi } from './renderer/FrameRenderer.tsx'

// Re-export frame types and utilities for convenience
export type {
  Frame,
  Block,
  Processor,
  PipelineInstance,
} from '@tanstack/framework/react/chat/pipeline'

export {
  emptyFrame,
  renderFrameToRendered,
  renderFrameToRaw,
} from '@tanstack/framework/react/chat/pipeline'
