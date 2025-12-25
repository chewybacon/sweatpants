/**
 * settlers.ts
 *
 * Built-in settler functions and combinators for the dual buffer.
 *
 * A settler decides when and what content should move from pending to settled.
 * It yields the content to settle, elegantly combining "when" and "what".
 *
 * ## Usage
 *
 * ```typescript
 * import { timeout, paragraph, any, codeFence } from './settlers'
 *
 * // Basic paragraph settling - pass factory functions, NOT instances
 * dualBufferTransform({
 *   settler: paragraph,   // factory reference (not paragraph())
 * })
 * 
 * // For combinators that take parameters, create a wrapper factory:
 * dualBufferTransform({
 *   settler: () => any(timeout(150), paragraph()),  // inline factory
 * })
 * 
 * // Code fence aware settling with metadata
 * dualBufferTransform({
 *   settler: codeFence,          // factory reference
 *   processor: syntaxHighlight,  // factory reference
 * })
 * ```
 */
import type { Settler, SettleContext, MetadataSettler, SettleResult } from './types'

// --- Built-in Settlers ---

/**
 * Settle all pending content after a timeout.
 *
 * @param ms - Milliseconds to wait before settling
 */
export function timeout(ms: number): Settler {
  return function* ({ pending, elapsed }) {
    if (elapsed >= ms) {
      yield pending
    }
  }
}

/**
 * Settle up to each paragraph break (\n\n).
 *
 * Yields content up to and including each \n\n found.
 * Can yield multiple times if there are multiple paragraph breaks.
 */
export function paragraph(): Settler {
  return function* ({ pending }) {
    let remaining = pending
    let idx: number

    while ((idx = remaining.indexOf('\n\n')) !== -1) {
      yield remaining.slice(0, idx + 2)
      remaining = remaining.slice(idx + 2)
    }
  }
}

/**
 * Settle when pending buffer exceeds a size limit.
 *
 * @param chars - Maximum characters before forcing a settle
 */
export function maxSize(chars: number): Settler {
  return function* ({ pending }) {
    if (pending.length >= chars) {
      yield pending
    }
  }
}

/**
 * Settle up to each sentence end (. or ? or ! followed by space or newline).
 *
 * Useful for settling at natural language boundaries.
 */
export function sentence(): Settler {
  return function* ({ pending }) {
    // Match sentence endings: . or ? or ! followed by space, newline, or end
    const pattern = /[.?!](?:\s|$)/g
    let lastEnd = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(pending)) !== null) {
      const endIdx = match.index + match[0].length
      yield pending.slice(lastEnd, endIdx)
      lastEnd = endIdx
    }
  }
}

/**
 * Settle up to each line break (\n).
 *
 * More aggressive than paragraph() - settles on every newline.
 */
export function line(): Settler {
  return function* ({ pending }) {
    let remaining = pending
    let idx: number

    while ((idx = remaining.indexOf('\n')) !== -1) {
      yield remaining.slice(0, idx + 1)
      remaining = remaining.slice(idx + 1)
    }
  }
}

// --- Combinators ---

/**
 * Combine settlers with OR logic.
 *
 * Tries each settler in order. Returns the first one that yields content.
 * If none yield, nothing settles.
 *
 * @example
 * ```typescript
 * // Settle on paragraph breaks, or timeout after 150ms
 * any(paragraph(), timeout(150))
 * ```
 */
export function any(...settlers: Settler[]): Settler {
  return function* (ctx: SettleContext) {
    for (const settler of settlers) {
      const chunks = [...settler(ctx)]
      if (chunks.length > 0) {
        yield* chunks
        return
      }
    }
  }
}

/**
 * Combine settlers - all must agree, use smallest yield.
 *
 * All settlers must yield something. Returns the shortest yielded content.
 * Useful for "settle on paragraph break BUT only if timeout has passed".
 *
 * @example
 * ```typescript
 * // Only settle paragraphs after 100ms has passed
 * all(timeout(100), paragraph())
 * ```
 */
export function all(...settlers: Settler[]): Settler {
  return function* (ctx: SettleContext) {
    const results = settlers.map((settler) => [...settler(ctx)])

    // All must yield something
    if (results.some((r) => r.length === 0)) {
      return
    }

    // Find the smallest total content
    const totals = results.map((chunks) => chunks.join(''))
    const smallest = totals.reduce((a, b) => (a.length <= b.length ? a : b))

    if (smallest.length > 0) {
      yield smallest
    }
  }
}

/**
 * Default settler factory: paragraph breaks.
 * 
 * Settles on \n\n which aligns naturally with markdown structure.
 * Final content is flushed when stream ends.
 * 
 * This is the factory function used by dualBufferTransform when no settler is specified.
 */
export const defaultSettlerFactory = paragraph

// --- Metadata-Aware Settlers ---

/**
 * Code fence aware settler with metadata.
 * 
 * This settler is "smart" about code fences:
 * - Outside fences: settles on paragraph breaks (like paragraph())
 * - Inside fences: settles on each line break (for incremental highlighting)
 * - Yields SettleResult with metadata: { inCodeFence, language }
 * 
 * The metadata allows processors to know when content is inside a code fence
 * and what language it is, enabling syntax highlighting.
 * 
 * ## Example
 * 
 * ```typescript
 * const settler = codeFence()
 * const results = [...settler(ctx)]
 * // Results:
 * // { content: "Here's code:\n\n" }
 * // { content: "```python\n", meta: { inCodeFence: true, language: "python" } }
 * // { content: "def foo():\n", meta: { inCodeFence: true, language: "python" } }
 * // { content: "```\n", meta: { inCodeFence: false, language: "python" } }
 * ```
 */
export function codeFence(): MetadataSettler {
  // Track state across calls (stateful settler)
  let inFence = false
  let fenceLanguage = ''

  return function* (ctx: SettleContext): Iterable<SettleResult> {
    const { pending } = ctx
    let pos = 0

    while (pos < pending.length) {
      const remaining = pending.slice(pos)

      if (!inFence) {
        // Look for fence open or paragraph break
        const fenceMatch = remaining.match(/^```(\w*)\n/)
        const paragraphIdx = remaining.indexOf('\n\n')

        if (
          fenceMatch &&
          (paragraphIdx === -1 || fenceMatch.index! < paragraphIdx)
        ) {
          // Fence opens - settle everything before it (if any)
          if (fenceMatch.index! > 0) {
            const before = remaining.slice(0, fenceMatch.index!)
            yield { content: before }
            pos += before.length
          }
          // Enter the fence
          inFence = true
          fenceLanguage = fenceMatch[1] || ''
          // Yield the fence opening line with metadata
          yield {
            content: fenceMatch[0],
            meta: { inCodeFence: true, language: fenceLanguage },
          }
          pos += fenceMatch[0].length
        } else if (paragraphIdx !== -1) {
          // Paragraph break - settle up to and including \n\n
          const toSettle = remaining.slice(0, paragraphIdx + 2)
          yield { content: toSettle }
          pos += toSettle.length
        } else {
          // No fence, no paragraph break - nothing to settle yet
          break
        }
      } else {
        // Inside fence - look for fence close or line break
        const closeMatch = remaining.match(/^```\n?/)
        const lineIdx = remaining.indexOf('\n')

        if (closeMatch) {
          // Fence closes
          inFence = false
          yield {
            content: closeMatch[0],
            meta: { inCodeFence: false, language: fenceLanguage },
          }
          fenceLanguage = ''
          pos += closeMatch[0].length
        } else if (lineIdx !== -1) {
          // Settle each complete line inside fence
          const lineContent = remaining.slice(0, lineIdx + 1)
          yield {
            content: lineContent,
            meta: { inCodeFence: true, language: fenceLanguage },
          }
          pos += lineContent.length
        } else {
          // No complete line yet - wait for more input
          break
        }
      }
    }
  }
}

/**
 * Default metadata settler factory: code fence aware.
 * 
 * Use this when you need settler metadata for processors.
 * This is the factory function used when you want code fence awareness.
 */
export const defaultMetadataSettlerFactory = codeFence
