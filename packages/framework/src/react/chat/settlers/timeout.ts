/**
 * settlers/timeout.ts
 *
 * Timeout settler - settles after elapsed time.
 */
import type { Settler } from '../types/settler'

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
