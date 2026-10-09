import { expect, it } from "vitest";
import { validateJournalCollectionSize } from "../store/snapshot-codec.ts";
import { MAX_RECORDS_PER_SESSION } from "../store/durable-authority-snapshot-schema.ts";
import { assertJson } from "@sweatpants/foundation";
import { JOURNAL_PAYLOAD_MAX_DEPTH } from "../contract/payload-limits.ts";

const admit = (value: unknown) => assertJson(value, "$", { maxDepth: JOURNAL_PAYLOAD_MAX_DEPTH });

it("bounds each payload by depth, with bytes and collection counts as aggregate limits", () => {
  const fragment = Array.from({ length: 2000 }, () => 0);
  // The old arbitrary primitive-node budget is gone. Aggregate persistence
  // is bounded by encoded bytes and collection counts, not value duplication.
  expect(() => admit(Array.from({ length: 1001 }, () => fragment))).not.toThrow();
  let value: object = {};
  for (let i = 0; i < 100; i++) {
    value = { child: value };
  }
  expect(() => admit(value)).not.toThrow();
  for (let i = 0; i < 30; i++) {
    value = { child: value };
  }
  expect(() => admit(value)).toThrow();
  const cyclic: { child?: object } = {};
  cyclic.child = cyclic;
  expect(() => admit(cyclic)).toThrow();
});

it("rejects aggregate history growth even when individual records are valid", () => {
  expect(() => validateJournalCollectionSize(2, 512)).not.toThrow();
  expect(() => validateJournalCollectionSize(MAX_RECORDS_PER_SESSION + 1, 512)).toThrow(
    "Invalid durable authority snapshot",
  );
  expect(() => validateJournalCollectionSize(2, 64 * 1024 * 1024 + 1)).toThrow(
    "Invalid durable authority snapshot",
  );
});

it("rejects malformed Unicode and prototype keys before snapshot encoding", () => {
  expect(() => admit({ sessionId: "bad\ud800" })).toThrow();
  expect(() => admit({ "bad\udfff": "value" })).toThrow();
  expect(() => admit(JSON.parse('{"__proto__":{}}'))).toThrow();
  expect(() => admit({ sessionId: "valid😀" })).not.toThrow();
});

it("inspects the current boundary value when the same object is presented again", () => {
  const value: { message: string; child?: object } = { message: "valid" };
  expect(() => admit(value)).not.toThrow();

  value.message = "bad\ud800";
  expect(() => admit(value)).toThrow();

  value.message = "valid";
  value.child = value;
  expect(() => admit(value)).toThrow();
});
