/**
 * react/chat/types.ts
 *
 * Re-exports all types from types/index.ts.
 * This file exists for convenience - imports like `from './types'` work.
 */

// Re-export everything from types/index.ts
export * from './types/index'

// Also export RenderFrame (React-specific type)
import type { RenderDelta, ContentMetadata } from './types/index'

/**
 * A single render frame with full animation support.
 *
 * Contains the complete content state plus delta information
 * for animating transitions between frames.
 */
export interface RenderFrame {
  /** Full content at this frame */
  content: string
  /** Processed HTML for full content (if available) */
  html?: string
  /** Delta from previous frame - what's new */
  delta: RenderDelta
  /** Timestamp when this frame was produced */
  timestamp: number
  /** Metadata from processor (e.g., code fence info) */
  meta?: ContentMetadata
}
