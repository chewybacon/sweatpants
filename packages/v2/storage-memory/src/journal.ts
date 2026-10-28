import {
  createJournalBinding,
  createJournalRecord,
  type JournalRecord,
  type RequestRecord,
  type Accepted,
  type JournalBackend,
} from "@sweatpan.ts/durable";
import type { MemoryJournalOptions, MemoryJournal, MemoryJournalStore } from "./contracts.ts";

/** Create a process-local journal and owned tree; all returned data is detached. */
export function createMemoryJournal<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournal<R, Q, V, E, S> {
  return createMemoryJournalStore<R, Q, V, E, S>(options).open();
}

/** Retain authority independently of handles. Transactions stage only touched records. */
export function createMemoryJournalStore<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournalStore<R, Q, V, E, S> {
  const assembly = { ...options };
  const id = crypto.randomUUID();
  const records = new Map<string, JournalRecord>([[id, createJournalRecord(assembly.program)]]);
  const requests = new Map<string, RequestRecord>();
  const history = new Map<string, Accepted<unknown, unknown, unknown>[]>();
  const receipts = new Map<string, Accepted<unknown, unknown, unknown>>();
  const key = (execution: string, request: string) => JSON.stringify([execution, request]);
  const backend: JournalBackend<never> = {
    *transact(work) {
      const writes = new Map<string, JournalRecord>();
      const requestWrites = new Map<string, RequestRecord>();
      const appends = new Map<string, Accepted<unknown, unknown, unknown>[]>();
      const result = yield* work({
        *get(execution) {
          return structuredClone(writes.get(execution) ?? records.get(execution));
        },
        *set(execution, record) {
          writes.set(execution, structuredClone(record));
        },
        *request(execution, request) {
          return structuredClone(
            requestWrites.get(key(execution, request)) ?? requests.get(key(execution, request)),
          );
        },
        *setRequest(execution, request, record) {
          requestWrites.set(key(execution, request), structuredClone(record));
        },
        *accepted(execution, receipt) {
          return structuredClone(
            appends.get(execution)?.find((entry) => entry.receipt === receipt) ??
              receipts.get(key(execution, receipt)),
          );
        },
        *append(execution, entry) {
          const pending = appends.get(execution) ?? [];
          if (
            entry.sequence !== (history.get(execution)?.length ?? 0) + pending.length ||
            receipts.has(key(execution, entry.receipt)) ||
            pending.some((prior) => prior.receipt === entry.receipt)
          ) {
            throw new Error("Conflicting accepted history");
          }
          pending.push(structuredClone(entry));
          appends.set(execution, pending);
        },
      });
      // Clone before publishing: uncloneable projections/results roll back every record.
      const detached = structuredClone(result);
      for (const [execution, record] of writes) {
        records.set(execution, record);
      }
      for (const [request, record] of requestWrites) {
        requests.set(request, record);
      }
      for (const [execution, entries] of appends) {
        const retained = history.get(execution) ?? [];
        retained.push(...entries);
        history.set(execution, retained);
        for (const entry of entries) {
          receipts.set(key(execution, entry.receipt), entry);
        }
      }
      return detached;
    },
    *history(execution, from, end, limit) {
      return structuredClone(
        (history.get(execution) ?? []).slice(from, Math.min(end, from + limit)),
      );
    },
  };
  return { id, open: () => createJournalBinding<R, Q, V, E, S>(assembly, backend, id) };
}
