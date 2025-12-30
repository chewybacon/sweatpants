/**
 * lib/chat/patches/buffer.ts
 *
 * Buffer patches for the dual-buffer rendering system.
 * These patches enable progressive rendering with settled/pending content.
 */

import type { ContentMetadata, RenderDelta, RevealHint } from '../core-types'

// =============================================================================
// BUFFER PATCHES
// =============================================================================

/**
 * Patch emitted when content settles in the buffer.
 */
export interface BufferSettledPatch {
  type: 'buffer_settled'
  /** The chunk that just settled */
  content: string
  /** Previous settled total */
  prev: string
  /** New settled total (prev + content) */
  next: string
  /** Parsed HTML, if markdown processor ran */
  html?: string
  /** Parsed AST, for advanced processing */
  ast?: unknown
  /** Progressive enhancement pass */
  pass?: 'quick' | 'full'
  /** Content metadata (e.g., code fence info) */
  meta?: ContentMetadata
  /** Allow additional processor fields */
  [key: string]: unknown
}

/**
 * Patch emitted when pending buffer updates.
 */
export interface BufferPendingPatch {
  type: 'buffer_pending'
  /** Current pending buffer (full replacement) */
  content: string
}

/**
 * Patch emitted when raw buffer updates.
 */
export interface BufferRawPatch {
  type: 'buffer_raw'
  /** Current raw buffer (full replacement) */
  content: string
}

/**
 * Patch emitted when a new render frame is ready.
 */
export interface BufferRenderablePatch {
  type: 'buffer_renderable'
  /** Previous frame content */
  prev: string
  /** Current frame content */
  next: string
  /** Processed HTML for current frame */
  html?: string
  /** Delta information for animation */
  delta?: RenderDelta
  /** Reveal hint for animation control */
  revealHint?: RevealHint
  /** Timestamp when this frame was produced */
  timestamp?: number
  /** Metadata from processors */
  meta?: ContentMetadata
  /** Allow additional processor fields */
  [key: string]: unknown
}

/**
 * Buffer patches - for dual-buffer rendering.
 */
export type BufferPatch =
  | BufferSettledPatch
  | BufferPendingPatch
  | BufferRawPatch
  | BufferRenderablePatch
