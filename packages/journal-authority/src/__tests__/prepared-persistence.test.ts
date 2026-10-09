import { canonicalDigest, stableTupleHash } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import {
  createTextExecutionObject,
  createPrivateSegment,
  createContentAddressedExecutionObject,
  readExecutionObject,
  prepareExecutionObject,
  readPrivateSegment,
  preparePrivateSegment,
} from "../store/store-persistence.ts";

describe("owned persistence values", () => {
  it("owns text metadata before hashing and retains its structured value", async () => {
    const fields = {
      objectId: "one",
      lifetimeScope: "execution" as const,
      scopeOwnerId: "ex",
      objectKind: "snapshot",
      createdAt: 1,
    };
    const pending = createTextExecutionObject(fields, '{"answer":42}');
    fields.objectId = "changed";
    const object = await pending;
    expect(Object.isFrozen(object)).toBe(true);
    expect(object.objectId).toBe("one");
    expect(object.contentHash).toBe(canonicalDigest(object.body));
    expect(prepareExecutionObject(object)).toBe(object);
    expect(await readExecutionObject(prepareExecutionObject(object))).toEqual(object);
    expect(() => prepareExecutionObject({ ...object, body: "changed" })).toThrow(
      /content metadata/,
    );
  });

  it("owns content-addressed inputs before suspension and preserves content identity", async () => {
    const body = { nested: { answer: 42 } };
    const fields = {
      lifetimeScope: "execution" as const,
      scopeOwnerId: "ex",
      objectKind: "context",
      createdAt: 1,
    };
    const prefix = ["ex", "context"];
    const hash = canonicalDigest(body);
    const pending = createContentAddressedExecutionObject(fields, prefix, body);
    body.nested.answer = 0;
    fields.scopeOwnerId = "changed";
    prefix[0] = "changed";
    const object = await pending;
    expect(object.scopeOwnerId).toBe("ex");
    expect(object.body).toEqual({ nested: { answer: 42 } });
    expect(object.contentHash).toBe(hash);
    expect(object.objectId).toBe(stableTupleHash(["ex", "context", hash]));
    expect(Object.isFrozen((object.body as typeof body).nested)).toBe(true);
    expect(prepareExecutionObject(object)).toBe(object);
    expect(await readExecutionObject(prepareExecutionObject(object))).toEqual(object);
    expect(() => prepareExecutionObject({ ...object, body })).toThrow(/content metadata/);
  });

  it("owns segment entries and verifies copied values through the ordinary boundary", async () => {
    const entries = [{ nested: { answer: 42 } }];
    const fields = {
      executionId: "ex",
      taskId: "task",
      previous: null,
      firstSequence: "1",
      lastSequence: "1",
      createdAt: 1,
    };
    const pending = createPrivateSegment(fields, entries);
    entries[0]!.nested.answer = 0;
    fields.taskId = "changed";
    const segment = await pending;
    expect(segment.entries).toEqual([{ nested: { answer: 42 } }]);
    expect(segment.taskId).toBe("task");
    expect(Object.isFrozen(segment.entries[0])).toBe(true);
    expect(preparePrivateSegment(segment)).toBe(segment);
    expect(await readPrivateSegment(preparePrivateSegment(segment))).toEqual(segment);
    expect(() => preparePrivateSegment({ ...segment, entries: [null] })).toThrow(/hash/);
  });
});
