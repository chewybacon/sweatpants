import { expect, it } from "vitest";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import { validateJournalCollectionBounds } from "../store/snapshot-codec.ts";
import { MAX_RECORDS_PER_SESSION } from "../store/durable-authority-snapshot-schema.ts";
import { durableAuthoritySnapshotBoundsParser } from "../store/durable-authority-snapshot-schema.ts";
import { retainParsedValue } from "../state/accepted-values.ts";

it("counts retained values at every occurrence and at their new nesting depth", () => {
  const fragment = retainParsedValue(Array.from({ length: 2000 }, () => 0));
  expect(durableAuthoritySnapshotBoundsParser.parse([fragment, fragment]).ok).toBe(true);
  const many = durableAuthoritySnapshotBoundsParser.parse(
    Array.from({ length: 1001 }, () => fragment),
  );
  expect(many).toMatchObject({
    ok: false,
    issues: [{ message: "snapshot node count exceeds limit" }],
  });

  let value: object = {};
  for (let i = 0; i < 100; i++) value = { child: value };
  retainParsedValue(value);
  expect(durableAuthoritySnapshotBoundsParser.parse(value).ok).toBe(true);
  for (let i = 0; i < 30; i++) value = { child: value };
  expect(durableAuthoritySnapshotBoundsParser.parse(value)).toMatchObject({
    ok: false,
    issues: [{ message: "snapshot depth exceeds limit" }],
  });

  const cyclic: { child?: object } = {};
  cyclic.child = cyclic;
  expect(durableAuthoritySnapshotBoundsParser.parse(cyclic).ok).toBe(false);
});

it("rejects aggregate history growth even when individual records are valid", () => {
  const records: DurableSemanticRecord[] = Array.from(
    { length: MAX_RECORDS_PER_SESSION + 1 },
    (_, offset) => ({
      offset: String(offset),
      eventId: `event-${offset}`,
      sessionId: "session",
      payload: { type: "AdvancementReleased", taskId: "root", leaseEpoch: 1, reason: "parked" },
    }),
  );
  expect(() => validateJournalCollectionBounds("session", records.slice(0, 2))).not.toThrow();
  expect(() => validateJournalCollectionBounds("session", records)).toThrow(
    "Invalid durable authority snapshot",
  );
});

it("rejects malformed Unicode and prototype keys before snapshot encoding", () => {
  expect(durableAuthoritySnapshotBoundsParser.parse({ sessionId: "bad\ud800" }).ok).toBe(false);
  expect(durableAuthoritySnapshotBoundsParser.parse({ "bad\udfff": "value" }).ok).toBe(false);
  expect(durableAuthoritySnapshotBoundsParser.parse(JSON.parse('{"__proto__":{}}')).ok).toBe(false);
  expect(durableAuthoritySnapshotBoundsParser.parse({ sessionId: "valid😀" }).ok).toBe(true);
});
