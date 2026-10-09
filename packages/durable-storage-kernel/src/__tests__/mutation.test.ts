import { describe, expect, it, vi } from "vitest";
import { durableKey } from "../codec.ts";
import type { DurableMutation, ImmutableEnsure, StoredAuthorityRecord } from "../contract.ts";
import { evaluateMutation, type MutationSnapshot } from "../mutation.ts";

const ensure: ImmutableEnsure = {
  name: "segment",
  collection: "execution-journal-segments",
  key: durableKey("segment"),
  alternateKeys: [durableKey("execution", "task", "0", "1")],
  fingerprint: "hash",
  value: [1, 2],
};
const current: StoredAuthorityRecord = {
  collection: "execution-controls",
  key: durableKey("execution"),
  revision: "3",
  fence: "7",
  value: [0],
};
const authority: NonNullable<DurableMutation["authority"]> = {
  name: "control",
  collection: current.collection,
  key: current.key,
  expected: { revision: "3", fence: "7" },
  next: { revision: "4", value: [2] },
};

describe("mutation decisions", () => {
  it("returns the accepted claim before checking stale authority or loading ensures", () => {
    const claim = { ...ensure, name: "receipt", key: durableKey("receipt") };
    const candidates = vi.fn<MutationSnapshot["candidates"]>(() => [ensure]);
    const result = evaluateMutation(
      { claim, authority, ensures: [ensure] },
      { claim, authority: null, candidates },
    );
    expect(result).toEqual({ status: "claim_exists", claim: "receipt", existing: claim });
    expect(candidates).not.toHaveBeenCalled();
  });

  it.each([
    { record: { ...current, revision: "2", fence: "6" }, mismatch: "fence" },
    { record: { ...current, revision: "2" }, mismatch: "revision" },
    { record: null, mismatch: "fence" },
  ])("rejects $mismatch before loading ensures", ({ record, mismatch }) => {
    const candidates = vi.fn<MutationSnapshot["candidates"]>(() => [ensure]);
    expect(
      evaluateMutation(
        { authority, ensures: [ensure] },
        { claim: null, authority: record, candidates },
      ),
    ).toEqual({ status: "authority_conflict", authority: "control", mismatch, current: record });
    expect(candidates).not.toHaveBeenCalled();
  });

  it("deduplicates aliases of the same record but rejects aliases pointing to different records", () => {
    const mutation = { ensures: [ensure] };
    const shared = { claim: null, authority: null };
    const replay = evaluateMutation(mutation, { ...shared, candidates: () => [ensure, ensure] });
    expect(replay).toEqual({
      status: "ready",
      inserts: [],
      outcome: { status: "committed", authority: null, ensured: { segment: ensure } },
    });
    const other = { ...ensure, key: durableKey("other") };
    expect(
      evaluateMutation(mutation, { ...shared, candidates: () => [ensure, ensure, other] }),
    ).toEqual({ status: "immutable_conflict", write: "segment", existing: other });
  });

  it("rejects conflicting content by fingerprint even when the primary identity matches", () => {
    const existing = { ...ensure, fingerprint: "different" };
    expect(
      evaluateMutation(
        { ensures: [ensure] },
        { claim: null, authority: null, candidates: () => [existing] },
      ),
    ).toEqual({ status: "immutable_conflict", write: "segment", existing });
  });

  it("allows alternate-key replay alone but requires the primary identity when moving authority", () => {
    const existing = { ...ensure, key: durableKey("previous-segment") };
    const snapshot = { claim: null, authority: current, candidates: () => [existing] };
    expect(evaluateMutation({ ensures: [ensure] }, snapshot)).toEqual({
      status: "ready",
      inserts: [],
      outcome: { status: "committed", authority: null, ensured: { segment: existing } },
    });
    expect(evaluateMutation({ authority, ensures: [ensure] }, snapshot)).toEqual({
      status: "immutable_conflict",
      write: "segment",
      existing,
    });
  });

  it.each([undefined, null, "7", "8"])("preserves fence fallback for next fence %s", (fence) => {
    const result = evaluateMutation(
      { authority: { ...authority, next: { ...authority.next, fence } }, ensures: [] },
      { claim: null, authority: current, candidates: () => [] },
    );
    expect(result).toMatchObject({
      status: "ready",
      outcome: { authority: { revision: "4", fence: fence ?? "7" } },
    });
  });

  it("plans only missing inserts and retains admitted values for the commit", () => {
    const missing = { ...ensure, name: "new", key: durableKey("new"), alternateKeys: [] };
    const nextValue = [4];
    const missingValue = [5];
    const result = evaluateMutation(
      {
        authority: { ...authority, next: { revision: "4", value: nextValue } },
        ensures: [ensure, { ...missing, value: missingValue }],
      },
      {
        claim: null,
        authority: current,
        candidates: (entry) => (entry.name === "segment" ? [ensure] : []),
      },
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("Expected a write plan");
    }
    expect(result.inserts.map((entry) => entry.name)).toEqual(["new"]);
    expect(result.outcome.authority?.value).toBe(nextValue);
    expect(result.outcome.ensured.new?.value).toBe(missingValue);
    expect(result.outcome.ensured.segment).toEqual(ensure);
  });

  it("validates the mutation even if a claim already exists", () => {
    const claim = { ...ensure, name: "receipt", key: durableKey("receipt") };
    expect(() =>
      evaluateMutation(
        { claim, ensures: [ensure, ensure] },
        { claim, authority: null, candidates: () => [] },
      ),
    ).toThrow("Duplicate mutation component name");
  });
});
