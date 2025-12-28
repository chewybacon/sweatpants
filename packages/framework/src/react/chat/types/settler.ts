/**
 * types/settler.ts
 *
 * Types for settlers - functions that decide when content moves from pending to settled.
 */

// --- Base Metadata Types ---

/**
 * Base metadata that all settlers can provide.
 * Plugins extend this interface for their own metadata.
 */
export interface BaseSettleMeta {
  [key: string]: unknown
}

/**
 * Metadata that settlers can attach to settled content.
 *
 * This allows processors to know context about what they're processing,
 * e.g., whether content is inside a code fence and what language it is.
 */
export interface SettleMeta extends BaseSettleMeta {
  /** Whether this content is inside a code fence */
  inCodeFence?: boolean
  /** The language of the code fence (e.g., 'python', 'typescript') */
  language?: string
}

// --- Settle Context ---

/**
 * Context passed to a settler function.
 *
 * The settler uses this to decide what content (if any) should settle.
 */
export interface SettleContext {
  /** Current pending buffer (content not yet settled) */
  pending: string
  /** Milliseconds since pending started accumulating */
  elapsed: number
  /** Already settled content (for context, e.g., detecting code blocks) */
  settled: string
  /** The patch that triggered this settle check */
  patch: { type: string }
  /**
   * True when this is the final flush at stream end.
   *
   * Settlers should settle ALL remaining content, even incomplete lines.
   * For code fence settlers, this means:
   * - Treating ``` without trailing newline as a valid fence close
   * - Settling any remaining content inside an unclosed fence
   */
  flush?: boolean
}

// --- Settle Result ---

/**
 * Result yielded by a settler - content plus optional metadata.
 *
 * The metadata allows settlers to communicate context to processors,
 * enabling smart processing like syntax highlighting for code fences.
 */
export interface SettleResult<TMeta extends BaseSettleMeta = SettleMeta> {
  /** The content to settle (must be a prefix of pending) */
  content: string
  /** Optional metadata about this content */
  meta?: TMeta
}

// --- Settler Types ---

/**
 * A settler decides when and what content should move from pending to settled.
 *
 * Instead of returning a boolean (when) and having the buffer decide (what),
 * the settler yields the actual content to settle. This elegantly combines
 * "when" and "what" into a single concept.
 *
 * ## Examples
 *
 * ```typescript
 * // Timeout: settle everything after 150ms
 * function* timeoutSettler({ pending, elapsed }) {
 *   if (elapsed >= 150) {
 *     yield pending
 *   }
 * }
 *
 * // Paragraph: settle up to each \n\n
 * function* paragraphSettler({ pending }) {
 *   const idx = pending.indexOf('\n\n')
 *   if (idx !== -1) {
 *     yield pending.slice(0, idx + 2)
 *   }
 * }
 * ```
 *
 * ## Rules
 *
 * 1. Yielded content MUST be a prefix of `pending`
 * 2. Yield multiple times to settle in chunks
 * 3. Yield nothing to leave everything in pending
 * 4. The sum of yielded content is removed from pending
 */
export type Settler = (ctx: SettleContext) => Iterable<string>

/**
 * A metadata-aware settler that yields SettleResult objects with optional metadata.
 *
 * Use this for settlers that need to communicate context to processors,
 * like code fence detection for syntax highlighting.
 */
export type MetadataSettler<TMeta extends BaseSettleMeta = SettleMeta> = (
  ctx: SettleContext
) => Iterable<SettleResult<TMeta>>

/**
 * A factory function that creates a fresh Settler instance.
 *
 * Stateful settlers (like codeFence) track state across calls that must be
 * reset between streaming sessions. By passing a factory to the buffer transform,
 * a fresh settler is created on each `streaming_start` event.
 */
export type SettlerFactory<TMeta extends BaseSettleMeta = SettleMeta> = () =>
  | Settler
  | MetadataSettler<TMeta>
