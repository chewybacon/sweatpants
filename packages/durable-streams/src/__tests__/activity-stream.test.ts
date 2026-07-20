import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  ActivityStreamError,
  createInMemoryActivityStreamStore,
  type ActivityPayloadCodec,
  type ActivityRetentionPolicy,
  type ActivityStreamStore,
} from "../activity-stream.ts";

const codec: ActivityPayloadCodec<string> = {
  digest(value) {
    return `text:${value}`;
  },
  byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
  },
};

function store(now: () => number = () => 0): ActivityStreamStore<string> {
  return createInMemoryActivityStreamStore({ codec, now });
}

function code(error: unknown): string | undefined {
  return error instanceof ActivityStreamError ? error.code : undefined;
}

function* opened(
  selected: ActivityStreamStore<string>,
  retention: ActivityRetentionPolicy = { mode: "retain_forever" },
) {
  yield* selected.create({ streamId: "stream", retention });
  return yield* selected.claimWriter({
    streamId: "stream",
    writer: { kind: "task-attempt", taskId: "task", attemptId: "attempt-1" },
  });
}

describe("in-memory activity stream conformance", () => {
  it("creates stable identities idempotently and rejects conflicting retention", async () => {
    await run(function* () {
      const selected = store();
      yield* selected.create({ streamId: "stream", retention: { mode: "retain_forever" } });
      yield* selected.create({ streamId: "stream", retention: { mode: "retain_forever" } });
      let caught: unknown;
      try {
        yield* selected.create({ streamId: "stream", retention: { mode: "auto_delete_on_close" } });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_conflict");
      expect((yield* selected.read({ streamId: "stream" })).headCursor).toBe(0);
    });
  });

  it("steals writer fences atomically", async () => {
    await run(function* () {
      const selected = store();
      const first = yield* opened(selected);
      yield* selected.append({ fence: first, cursor: 1, payload: "one" });
      const second = yield* selected.claimWriter({
        streamId: "stream",
        writer: { kind: "activation", taskId: "task", activationId: "activation-2" },
      });
      expect(second.epoch).toBe(first.epoch + 1);
      let caught: unknown;
      try {
        yield* selected.append({ fence: first, cursor: 2, payload: "stale" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_fenced");
      yield* selected.append({ fence: second, cursor: 2, payload: "two" });
      expect(
        (yield* selected.read({ streamId: "stream" })).chunks.map((chunk) => chunk.payload),
      ).toEqual(["one", "two"]);
    });
  });

  it("enforces ordered cursors and content-checked duplicate appends", async () => {
    await run(function* () {
      const selected = store();
      const fence = yield* opened(selected);
      expect((yield* selected.append({ fence, cursor: 1, payload: "one" })).duplicate).toBe(false);
      expect((yield* selected.append({ fence, cursor: 1, payload: "one" })).duplicate).toBe(true);

      let caught: unknown;
      try {
        yield* selected.append({ fence, cursor: 1, payload: "different" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_conflict");
      try {
        yield* selected.append({ fence, cursor: 3, payload: "gap" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_cursor_gap");
      expect((yield* selected.read({ streamId: "stream" })).headCursor).toBe(1);
    });
  });

  it("reads reconnect tails without mutating other readers", async () => {
    await run(function* () {
      const selected = store();
      const fence = yield* opened(selected);
      for (const [index, payload] of ["one", "two", "three"].entries()) {
        yield* selected.append({ fence, cursor: index + 1, payload });
      }
      expect((yield* selected.read({ streamId: "stream", afterCursor: 1 })).chunks).toMatchObject([
        { cursor: 2, payload: "two" },
        { cursor: 3, payload: "three" },
      ]);
      expect((yield* selected.read({ streamId: "stream", afterCursor: 3 })).chunks).toEqual([]);
      expect((yield* selected.read({ streamId: "stream" })).chunks).toHaveLength(3);
      let caught: unknown;
      try {
        yield* selected.read({ streamId: "stream", afterCursor: 4 });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_cursor_gap");
    });
  });

  it("closes explicitly and rejects conflicting or post-close writes", async () => {
    await run(function* () {
      const selected = store();
      const fence = yield* opened(selected);
      yield* selected.append({ fence, cursor: 1, payload: "one" });
      const closure = { status: "complete" as const, summaryDigest: "summary" };
      expect((yield* selected.close({ fence, close: closure })).duplicate).toBe(false);
      expect((yield* selected.close({ fence, close: closure })).duplicate).toBe(true);
      expect((yield* selected.read({ streamId: "stream" })).close).toEqual(closure);

      let caught: unknown;
      try {
        yield* selected.append({ fence, cursor: 2, payload: "late" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_closed");
      try {
        yield* selected.close({ fence, close: { status: "aborted" } });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_conflict");
    });
  });

  it("applies auto-delete, forever, and ttl retention at the exact boundary", async () => {
    let time = 100;
    await run(function* () {
      const auto = store(() => time);
      const autoFence = yield* opened(auto, { mode: "auto_delete_on_close" });
      yield* auto.close({ fence: autoFence, close: { status: "complete" } });
      let caught: unknown;
      try {
        yield* auto.read({ streamId: "stream" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_not_found");

      const forever = store(() => time);
      const foreverFence = yield* opened(forever);
      yield* forever.close({ fence: foreverFence, close: { status: "aborted" } });
      time = 10_000;
      expect((yield* forever.read({ streamId: "stream" })).close?.status).toBe("aborted");

      time = 100;
      const ttl = store(() => time);
      const ttlFence = yield* opened(ttl, { mode: "retain_until_ttl", ttlMs: 50 });
      yield* ttl.close({ fence: ttlFence, close: { status: "error", errorCode: "failed" } });
      time = 149;
      expect((yield* ttl.read({ streamId: "stream" })).close?.status).toBe("error");
      time = 150;
      try {
        yield* ttl.read({ streamId: "stream" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_not_found");
    });
  });

  it("validates ids, writers, cursors, ttl, and error closures", async () => {
    await run(function* () {
      const selected = store();
      const failures: Array<() => Generator> = [
        () => selected.create({ streamId: "", retention: { mode: "retain_forever" } }),
        () =>
          selected.create({
            streamId: "bad-ttl",
            retention: { mode: "retain_until_ttl", ttlMs: 0 },
          }),
      ];
      for (const failure of failures) {
        let caught: unknown;
        try {
          yield* failure();
        } catch (error) {
          caught = error;
        }
        expect(code(caught)).toBe("activity_stream_conflict");
      }

      const fence = yield* opened(selected);
      let caught: unknown;
      try {
        yield* selected.append({ fence, cursor: 0, payload: "zero" });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_cursor_gap");
      try {
        yield* selected.close({ fence, close: { status: "error", errorCode: "" } });
      } catch (error) {
        caught = error;
      }
      expect(code(caught)).toBe("activity_stream_conflict");
    });
  });
});
