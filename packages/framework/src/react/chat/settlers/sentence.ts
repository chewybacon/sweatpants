/**
 * settlers/sentence.ts
 *
 * Sentence settler - settles on sentence boundaries.
 */
import type { Settler } from '../types/settler'

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
