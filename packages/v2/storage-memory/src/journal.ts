import {
  createJournalBinding,
  createJournalRecord,
  type JournalRecord,
  type JournalBackend,
} from "@sweatpan.ts/durable";
import type { MemoryJournalOptions, MemoryJournal, MemoryJournalStore } from "./contracts.ts";
import { transactMemory } from "./transaction.ts";

/** Create a process-local journal and owned tree; all returned data is detached. */
export function createMemoryJournal<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournal<R, Q, V, E, S> {
  return createMemoryJournalStore<R, Q, V, E, S>(options).open();
}

/** Retain authority records independently of handles; each open starts fresh code bindings. */
export function createMemoryJournalStore<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournalStore<R, Q, V, E, S> {
  const assembly = { ...options };
  const id = crypto.randomUUID();
  let records = new Map<string, JournalRecord>([[id, createJournalRecord(assembly.program)]]);
  const backend: JournalBackend<never> = {
    *transact(decide) {
      return transactMemory(
        () => {
          const draft = structuredClone(records);
          return { state: draft, result: decide(draft) };
        },
        (next) => {
          records = next;
        },
      );
    },
  };
  return { id, open: () => createJournalBinding<R, Q, V, E, S>(assembly, backend, id) };
}
