/**
 * settlers/paragraph.ts
 *
 * Paragraph settler - settles on double newlines.
 */
import type { Settler } from '../types/settler'

/**
 * Settle up to each paragraph break (\n\n).
 *
 * Yields content up to and including each \n\n found.
 * Can yield multiple times if there are multiple paragraph breaks.
 *
 * This is the default settler and works well for markdown content.
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
