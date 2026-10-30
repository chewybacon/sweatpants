import type { Outcome } from "@standard-durability/core";

/** Step a live iterator; exceptions become exit data without imposing scope policy. */
export function stepContinuation<R, Q>(
  iterator: Iterator<Q, R, unknown>,
  reply: Outcome<unknown, unknown>,
): IteratorResult<Q, Outcome<R, unknown>> {
  try {
    if (!reply.ok && !iterator.throw) {
      throw reply.error;
    }
    const next = reply.ok ? iterator.next(reply.value) : iterator.throw!(reply.error);
    return next.done ? { done: true, value: { ok: true, value: next.value } } : next;
  } catch (error) {
    return { done: true, value: { ok: false, error } };
  }
}
