/**
 * settlers/line.ts
 *
 * Line settler - settles on each newline.
 */
import type { Settler } from '../types/settler'

/**
 * Settle up to each line break (\n).
 *
 * More aggressive than paragraph() - settles on every newline.
 * Useful when you want immediate feedback per line.
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
