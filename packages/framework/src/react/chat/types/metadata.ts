/**
 * types/metadata.ts
 *
 * Generic metadata types used across patches, processors, and rendering.
 * 
 * These types allow processors and renderers to attach context about content.
 */

/**
 * Base metadata that can be attached to content.
 * Plugins extend this interface for their own metadata.
 */
export interface BaseContentMetadata {
  [key: string]: unknown
}

/**
 * Content metadata for patches.
 *
 * This allows processors and renderers to know context about what they're processing,
 * e.g., whether content is inside a code fence and what language it is.
 */
export interface ContentMetadata extends BaseContentMetadata {
  /** Whether this content is inside a code fence */
  inCodeFence?: boolean
  /** The language of the code fence (e.g., 'python', 'typescript') */
  language?: string
}
