/**
 * Terminal Pipeline
 *
 * Pipeline configuration for terminal-based rendering.
 * Uses ANSI codes instead of HTML for output.
 *
 * ## Lazy Pipeline
 *
 * The pipeline is lazy - tokens are pushed/buffered and frames are pulled on-demand:
 *
 * ```ts
 * const pipeline = createTerminalPipeline()
 *
 * // Push tokens (fast, just buffers)
 * pipeline.push('# Hello\n')
 * pipeline.push('```python\nx = 1\n```\n')
 *
 * // Pull frame (runs parser + processors)
 * const frame = yield* pipeline.pull()
 *
 * // Flush at end of stream
 * const finalFrame = yield* pipeline.flush()
 * ```
 */
import { createPipeline } from '@sweatpants/framework/react/chat/pipeline'
import type { PipelineConfig, Pipeline } from '@sweatpants/framework/react/chat/pipeline'

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
 * Uses the lazy push/pull API:
 * - push(chunk): Buffer content (sync, no processing)
 * - pull(): Process buffer and return frame (async)
 * - flush(): Finalize stream and return final frame
 */
export function createTerminalPipeline(): Pipeline {
  const config: PipelineConfig = {
    processors: terminalProcessors,
  }

  return createPipeline(config)
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
  Pipeline,
} from '@sweatpants/framework/react/chat/pipeline'

export {
  emptyFrame,
  renderFrameToRendered,
  renderFrameToRaw,
} from '@sweatpants/framework/react/chat/pipeline'
