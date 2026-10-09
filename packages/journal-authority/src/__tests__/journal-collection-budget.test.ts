import { expect, it } from "vitest";
import { appendJournalCollection, type JournalCollection } from "../shell/journal.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";

function collection(records: DurableSemanticRecord[]): JournalCollection {
  const sessionId = "session-😀";
  return {
    sessionId,
    records,
    encodedBytes: new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        sessions: [],
        nextNonce: 0,
        records: [[sessionId, records]],
      }),
    ).byteLength,
  };
}
function record(offset: number): DurableSemanticRecord {
  return {
    sessionId: "session-😀",
    offset: String(offset),
    eventId: `event:${offset}`,
    payload: { type: "AdvancementReleased", taskId: "root", leaseEpoch: offset, reason: "parked" },
  };
}
it("append budgets exactly match cold UTF-8 encoding across empty and nonempty batches", () => {
  let current = collection([]);
  for (const records of [[], [record(0)], [], [record(1), record(2)]]) {
    const before = current;
    const next = appendJournalCollection(current, collection(records));
    expect(next).toEqual(collection([...before.records, ...records]));
    expect(before.records.length + records.length).toBe(next.records.length);
    current = next;
  }
});
it("rejects the prospective byte budget without changing the accepted collection", () => {
  const prior = { ...collection([record(0)]), encodedBytes: 64 * 1024 * 1024 };
  const before = structuredClone(prior);
  expect(() => appendJournalCollection(prior, collection([record(1)]))).toThrow(
    "Invalid durable authority snapshot",
  );
  expect(prior).toEqual(before);
});
