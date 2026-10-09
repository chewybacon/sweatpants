import { createContext } from "effection";

/** Numeric-only storage observations used to certify bounded history reads. */
export interface HistoryStoreReadObserver {
  publicHistoryIndexPage(rows: number): void;
  publicHistorySegment(encodedBytes: number): void;
  publicHistoryPageMaterialized(payloadBytes: number): void;
}

/** Optional observation seam; it carries no payload content or storage authority. */
export const HistoryStoreReadObservationContext = createContext<HistoryStoreReadObserver>(
  "history-store-read-observation",
);
