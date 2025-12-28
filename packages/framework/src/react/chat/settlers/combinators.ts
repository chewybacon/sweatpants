/**
 * settlers/combinators.ts
 *
 * Settler combinators for composing settlers.
 */
import type { Settler, SettleContext } from '../types/settler'

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
