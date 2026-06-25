/**
 * parallel — framework sugar over Effection's `all([...])` for concurrent
 * sub-calls (Spec REQ-005). Adds progress aggregation and a uniform
 * cancellation policy on top of the primitive.
 *
 * `parallel([...])` is documented as sugar over `all([...])`; the runtime
 * already fans out sub-session events tagged by sub-session ID and routes
 * elicit/sample replies by requestId (REQ-015).
 */

import { all, type Operation } from 'effection'

export interface ParallelOptions {
  /**
   * Cancellation policy:
   * - "all" (default): wait for all to complete.
   * - "first": complete when the first sub-call resolves; halt the rest.
   */
  policy?: 'all' | 'first'
}

/**
 * Run sub-call operations concurrently. By default returns when all complete
 * (identical to `all([...])`). With `policy: "first"`, returns the first
 * result and halts the remainder.
 */
export function parallel<T>(
  ops: Operation<T>[],
  options: ParallelOptions = {},
): Operation<T[]> {
  if (options.policy === 'first') {
    return parallelFirst(ops)
  }
  return all(ops) as Operation<T[]>
}

function parallelFirst<T>(ops: Operation<T>[]): Operation<T[]> {
  return {
    *[Symbol.iterator]() {
      // Race: the first sub-call to resolve publishes its result and throws a
      // sentinel; Effection's `all` halts the remaining branches and rethrows,
      // which we catch here.
      let winner: T | undefined
      const WIN = Symbol('parallel.first')
      const racers = ops.map(
        (op) =>
          (function* (): Operation<unknown> {
            const value = yield* op
            winner = value as T
            throw WIN
          })(),
      )
      try {
        yield* all(racers as Operation<unknown>[])
      } catch (e) {
        if (e !== WIN) throw e
      }
      return winner !== undefined ? [winner] : []
    },
  }
}
