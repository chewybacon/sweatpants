/**
 * types/processor.ts
 *
 * Types for processors - functions that transform settled content.
 */
import type { Operation } from 'effection'
import type { ContentMetadata, BaseContentMetadata } from './metadata'

// --- Processed Output ---

/**
 * Output from a processor - the enriched settled content.
 *
 * Processors can add arbitrary fields that will be spread onto
 * the buffer_settled patch. Common fields:
 * - `html`: Parsed HTML (from markdown processor)
 * - `ast`: Parsed AST (for syntax highlighting, etc.)
 * - `pass`: For progressive enhancement ('quick' | 'full')
 *
 * The base `raw` field contains the original settled content.
 */
export interface ProcessedOutput {
  /** The raw settled content (always present) */
  raw: string
  /** Parsed HTML, if a markdown processor ran */
  html?: string
  /** Parsed AST, for advanced processing */
  ast?: unknown
  /** Progressive enhancement pass indicator */
  pass?: 'quick' | 'full'
  /** Allow additional fields for extensibility */
  [key: string]: unknown
}

// --- Processor Context ---

/**
 * Context passed to a processor function.
 */
export interface ProcessorContext<TMeta extends BaseContentMetadata = ContentMetadata> {
  /** The chunk of content being settled right now */
  chunk: string
  /** All previously settled content (for parsing context) */
  accumulated: string
  /** The full content after this chunk settles (accumulated + chunk) */
  next: string
  /** Metadata from the settler (e.g., code fence info) */
  meta?: TMeta
  /** HTML from previous processor in chain (for enhancement) */
  html?: string
}

// --- Processor Emit ---

/**
 * Emitter for processors to emit enriched output.
 *
 * Returns an Operation so processors must yield* to emit:
 * ```typescript
 * yield* emit({ raw, html: quickHighlight(raw), pass: 'quick' })
 * const fullHtml = yield* highlightCode(...)
 * yield* emit({ raw, html: fullHtml, pass: 'full' })
 * ```
 *
 * This enables true progressive enhancement - the quick pass is
 * sent to the client immediately, before the async work completes.
 */
export type ProcessorEmit = (output: ProcessedOutput) => Operation<void>

// --- Message Renderer ---

/**
 * A message renderer transforms message content to HTML.
 *
 * Used for rendering completed messages (both user and assistant).
 * This is simpler than the streaming processor - just a sync function.
 *
 * @param content - The raw message content
 * @returns HTML string, or undefined to skip rendering
 */
export type MessageRenderer = (content: string) => string | undefined
