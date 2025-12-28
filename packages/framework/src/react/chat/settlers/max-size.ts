/**
 * settlers/max-size.ts
 *
 * Max size settler - settles when buffer exceeds size.
 */
import type { Settler } from '../types/settler'

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
