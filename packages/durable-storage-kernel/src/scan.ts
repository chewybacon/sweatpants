import { DurableKernelError, type BoundedScan } from "./contract.ts";

export interface ScanMetadata {
  readonly key: string;
  readonly position: string;
  readonly payloadBytes: number;
}

/** Input is an indexed, ordered seek with at most maxRecords + 1 rows.
 * Select the contiguous page before fetching any payloads. Never skip a record
 * that exceeds the remaining byte budget: it belongs to the following page.
 */
export function planScanPage<T extends ScanMetadata>(
  request: BoundedScan,
  rows: readonly T[],
): {
  readonly selected: readonly T[];
  readonly nextCursor: string | null;
} {
  const selected: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 0) {
      throw new DurableKernelError(
        "durable_kernel_persisted_data_invalid",
        "Invalid indexed record byte count",
      );
    }
    if (selected.length === 0 && row.payloadBytes > request.maxPayloadBytes) {
      throw new DurableKernelError(
        "durable_kernel_scan_limit_exceeded",
        `Record at ${row.position} requires ${row.payloadBytes} payload bytes; scan allows ${request.maxPayloadBytes}`,
      );
    }
    if (
      selected.length >= request.maxRecords ||
      bytes + row.payloadBytes > request.maxPayloadBytes
    ) {
      return { selected, nextCursor: selected.at(-1)?.position ?? null };
    }
    selected.push(row);
    bytes += row.payloadBytes;
  }
  return { selected, nextCursor: null };
}
