import { type Json } from "@sweatpants/foundation";

export interface PrivateSegmentTarget {
  readonly maxEntries: number;
  readonly maxEncodedBytes: number;
}

export const DEFAULT_PRIVATE_SEGMENT_TARGET: PrivateSegmentTarget = Object.freeze({
  maxEntries: 256,
  maxEncodedBytes: 256 * 1024,
});

export const LOW_PRIVATE_SEGMENT_TARGET: PrivateSegmentTarget = Object.freeze({
  maxEntries: 10,
  maxEncodedBytes: 8 * 1024,
});

// Accepted JSON has the same byte length regardless of object-key ordering.
export function encodedJsonBytes(value: Json): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function segmentPrivateEntries(
  values: readonly Json[],
  target: PrivateSegmentTarget,
): readonly { readonly entries: readonly Json[]; readonly encodedBytes: number }[] {
  const segments: Array<{ entries: Json[]; encodedBytes: number }> = [];
  let entries: Json[] = [];
  let encodedBytes = 0;
  for (const value of values) {
    const valueBytes = encodedJsonBytes(value);
    if (
      entries.length > 0 &&
      (entries.length >= target.maxEntries || encodedBytes + valueBytes > target.maxEncodedBytes)
    ) {
      segments.push({ entries, encodedBytes });
      entries = [];
      encodedBytes = 0;
    }
    entries.push(value);
    encodedBytes += valueBytes;
  }
  if (entries.length > 0) segments.push({ entries, encodedBytes });
  return segments;
}
