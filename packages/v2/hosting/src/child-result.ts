import type { HostedResult, ChildHostingResult, ChildBlockingReason } from "./contracts.ts";

/** Convert an ordinary Host result without losing scheduling or blocking information.
 * Child output/participant grants remain in their owning journals and application views. */
export function childHostingResult<R, Q>(result: HostedResult<R, Q>): ChildHostingResult {
  switch (result.state) {
    case "completed":
    case "cancelled":
      return true;
    case "yielded":
      return result;
    case "child":
      return { state: "blocked", reason: result.reason ?? "unknown" };
    case "waiting":
    case "occupied":
    case "invalidated":
      return { state: "blocked", reason: result.state };
  }
}

/** Reduce already-joined children. A yield is retained; otherwise any unknown,
 * occupied or invalidated child prevents classifying the tree as a participant wait.
 * Empty/all-terminal groups are terminal. This helper does not start or join tasks. */
export function joinChildHostingResults(
  results: readonly ChildHostingResult[],
): ChildHostingResult {
  const reasons = new Set<ChildBlockingReason>();
  for (const result of results) {
    if (result === true) {
      continue;
    }
    if (result === false) {
      reasons.add("unknown");
    } else if (result.state === "yielded") {
      return result;
    } else {
      reasons.add(result.reason);
    }
  }
  for (const reason of ["unknown", "occupied", "invalidated", "waiting"] as const) {
    if (reasons.has(reason)) {
      return { state: "blocked", reason };
    }
  }
  return true;
}
