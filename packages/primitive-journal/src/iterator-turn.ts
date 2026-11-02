import type { Turn } from "./primitives.ts";

/** One synchronous pull. Authors are responsible for reaching a yield or return. */
export function advance<T, Request>(
  iterator: Iterator<Request, T, unknown>,
  reply?: unknown,
): Turn<T, Request> {
  const result = iterator.next(reply);
  return toTurn(result);
}

function toTurn<T, Request>(result: IteratorResult<Request, T>): Turn<T, Request> {
  return result.done
    ? { kind: "completed", value: result.value }
    : { kind: "suspended", request: result.value };
}
