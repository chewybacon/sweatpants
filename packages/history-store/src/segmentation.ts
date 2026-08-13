import { canonicalJson, type Json } from "@sweatpants/foundation";

export interface SegmentTarget {
  readonly maxEntries: number;
  readonly maxEncodedBytes: number;
}

export interface SegmentedValues {
  readonly entries: readonly Json[];
  readonly encodedBytes: number;
}

export interface CheckpointSpillTarget {
  readonly maxRoots: number;
  readonly maxEncodedBytes: number;
}

export const DEFAULT_PUBLIC_SEGMENT_TARGET: SegmentTarget = Object.freeze({
  maxEntries: 100,
  maxEncodedBytes: 1024 * 1024,
});

export const LOW_PUBLIC_SEGMENT_TARGET: SegmentTarget = Object.freeze({
  maxEntries: 4,
  maxEncodedBytes: 32 * 1024,
});

export const DEFAULT_CHECKPOINT_SPILL_TARGET: CheckpointSpillTarget = Object.freeze({
  maxRoots: 64,
  maxEncodedBytes: 2 * 1024 * 1024,
});

export const LOW_CHECKPOINT_SPILL_TARGET: CheckpointSpillTarget = Object.freeze({
  maxRoots: 8,
  maxEncodedBytes: 32 * 1024,
});

export interface CheckpointPublicationTargets {
  readonly spill: CheckpointSpillTarget;
  readonly segment: SegmentTarget;
}

export const DEFAULT_CHECKPOINT_TARGETS: CheckpointPublicationTargets = Object.freeze({
  spill: DEFAULT_CHECKPOINT_SPILL_TARGET,
  segment: DEFAULT_PUBLIC_SEGMENT_TARGET,
});

export const LOW_CHECKPOINT_TARGETS: CheckpointPublicationTargets = Object.freeze({
  spill: LOW_CHECKPOINT_SPILL_TARGET,
  segment: LOW_PUBLIC_SEGMENT_TARGET,
});

export function encodedJsonBytes(value: Json): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function rootPayloadBytes(roots: readonly Json[]): number {
  return roots.reduce<number>((sum, root) => sum + encodedJsonBytes(root), 0);
}

export function segmentValues(
  values: readonly Json[],
  target: SegmentTarget,
): readonly SegmentedValues[] {
  if (!Number.isSafeInteger(target.maxEntries) || target.maxEntries <= 0) {
    throw new Error("segment maxEntries must be a positive safe integer");
  }
  if (!Number.isSafeInteger(target.maxEncodedBytes) || target.maxEncodedBytes <= 0) {
    throw new Error("segment maxEncodedBytes must be a positive safe integer");
  }

  const segments: SegmentedValues[] = [];
  let entries: Json[] = [];
  let encodedBytes = 0;
  for (const value of values) {
    const valueBytes = encodedJsonBytes(value);
    const wouldExceedCount = entries.length >= target.maxEntries;
    const wouldExceedBytes =
      entries.length > 0 && encodedBytes + valueBytes > target.maxEncodedBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      segments.push({ entries: Object.freeze(entries), encodedBytes });
      entries = [];
      encodedBytes = 0;
    }
    entries.push(value);
    encodedBytes += valueBytes;
  }
  if (entries.length > 0) {
    segments.push({ entries: Object.freeze(entries), encodedBytes });
  }
  return Object.freeze(segments);
}

export function spillEligibleRoots(
  roots: readonly Json[],
  sealedCount: number,
  target: CheckpointSpillTarget,
): readonly Json[] {
  if (sealedCount <= 0) {
    return [];
  }
  const totalBytes = rootPayloadBytes(roots);
  if (roots.length <= target.maxRoots && totalBytes <= target.maxEncodedBytes) {
    return [];
  }
  const eligible = roots.slice(0, Math.min(sealedCount, roots.length));
  let bytes = 0;
  let count = 0;
  for (const root of eligible) {
    const next = encodedJsonBytes(root);
    if (count > 0 && (count >= target.maxRoots || bytes + next > target.maxEncodedBytes)) {
      break;
    }
    bytes += next;
    count += 1;
  }
  return Object.freeze(eligible.slice(0, count));
}

export function spillUntilWithinTarget(
  roots: readonly Json[],
  sealedCount: number,
  target: CheckpointSpillTarget,
): { readonly spilled: readonly Json[]; readonly hotRoots: readonly Json[] } {
  const spilled: Json[] = [];
  let hot = [...roots];
  let sealed = sealedCount;
  while (true) {
    const next = spillEligibleRoots(hot, sealed, target);
    if (next.length === 0) {
      break;
    }
    spilled.push(...next);
    hot = hot.slice(next.length);
    sealed = Math.max(0, sealed - next.length);
  }
  return { spilled: Object.freeze(spilled), hotRoots: Object.freeze(hot) };
}
