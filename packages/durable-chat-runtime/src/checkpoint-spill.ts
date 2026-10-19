import type { PublicProjectionRoot } from "@sweatpants/chat-core";
import { canonicalJson } from "@sweatpants/foundation";
import { type CheckpointPublicationTargets } from "@sweatpants/history-store";

/** Retain mutable roots; spill sealed roots in their existing order. */
export function spillRoots(
  roots: readonly PublicProjectionRoot[],
  target: CheckpointPublicationTargets["spill"],
): {
  readonly spilled: readonly PublicProjectionRoot[];
  readonly hotRoots: readonly PublicProjectionRoot[];
} {
  const hot = [...roots];
  const spilled: PublicProjectionRoot[] = [];
  let sizes: number[] | undefined;
  let bytes = 0;
  const over = () => {
    // Count pressure needs no encoding. Only measure the survivors once byte
    // pressure matters; roots do not change during this synchronous operation.
    if (hot.length > target.maxRoots) {
      return true;
    }
    if (sizes === undefined) {
      sizes = hot.map((root) => new TextEncoder().encode(canonicalJson(root)).byteLength);
      bytes = sizes.reduce((sum, size) => sum + size, 0);
    }
    return bytes > target.maxEncodedBytes;
  };
  while (over()) {
    const index = hot.findIndex((root) => root.state === "sealed");
    if (index < 0) {
      break;
    }
    spilled.push(hot[index]!);
    hot.splice(index, 1);
    if (sizes !== undefined) {
      bytes -= sizes[index]!;
      sizes.splice(index, 1);
    }
  }
  return { spilled, hotRoots: hot };
}
