/**
 * tripleBuffer.ts
 *
 * @deprecated Use `renderingBufferTransform` from './core/rendering-buffer' instead.
 * This file is kept for backward compatibility.
 *
 * Triple-buffering transform for streaming content.
 * See core/rendering-buffer.ts for the main implementation.
 */
import type { PatchTransform, SettlerFactory, ProcessorChain } from './types'
import {
  renderingBufferTransform,
  type RenderingBufferOptions,
} from './core/rendering-buffer'

/**
 * @deprecated Use `RenderingBufferOptions` instead.
 */
export interface TripleBufferOptions extends RenderingBufferOptions {
  /**
   * @deprecated Use `settler` instead. Will be removed in next major version.
   */
  chunker?: SettlerFactory

  /**
   * @deprecated Use `processor` instead. Will be removed in next major version.
   */
  enhancer?: ProcessorChain
}

/**
 * Create a triple buffer transform.
 *
 * @deprecated Use `renderingBufferTransform` from './core/rendering-buffer' instead.
 *
 * This function supports the deprecated `chunker` and `enhancer` options for
 * backward compatibility. New code should use `settler` and `processor` instead.
 */
export function tripleBufferTransform(
  options: TripleBufferOptions = {}
): PatchTransform {
  const {
    // Support both new names and deprecated aliases
    settler: settlerOpt,
    chunker: chunkerOpt,
    processor: processorOpt,
    enhancer: enhancerOpt,
    debug,
  } = options

  // Use settler/processor, fall back to deprecated chunker/enhancer
  const settler = settlerOpt ?? chunkerOpt
  const processor = processorOpt ?? enhancerOpt

  return renderingBufferTransform({
    settler,
    processor,
    debug,
  })
}

// Re-export the new types for convenience
export { renderingBufferTransform, type RenderingBufferOptions } from './core/rendering-buffer'
