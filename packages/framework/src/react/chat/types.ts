/**
 * types.ts
 *
 * Re-exports from the types/ directory for backward compatibility.
 * New code should import from specific type files or types/index.ts.
 */

// Re-export everything from types/index.ts
export * from './types/index'

// Also export RenderFrame which was in the old types but isn't used much
// Keeping for API compatibility

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
  delta: import('./types/patch').RenderDelta
  /** Timestamp when this frame was produced */
  timestamp: number
  /** Metadata from settler (e.g., code fence info) */
  meta?: import('./types/settler').SettleMeta
}
