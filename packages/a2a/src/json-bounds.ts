export const A2A_MAX_JSON_DEPTH = 64;
export const A2A_MAX_JSON_NODES = 100_000;

/** Applies cheap graph bounds before recursive JSON validation or normalization. */
export function assertBoundedA2AJson(value: unknown): void {
  const seen = new WeakSet();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      nodes += 1;
      if (nodes > A2A_MAX_JSON_NODES || current.depth > A2A_MAX_JSON_DEPTH) {
        throw new RangeError("A2A JSON exceeds complexity limits");
      }
      if (current.value === null || typeof current.value !== "object") {
        continue;
      }
      if (seen.has(current.value)) {
        throw new TypeError("A2A JSON contains a cycle");
      }
      seen.add(current.value);
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw error;
    }
    throw new TypeError("A2A JSON cannot be inspected safely", { cause: error });
  }
}
