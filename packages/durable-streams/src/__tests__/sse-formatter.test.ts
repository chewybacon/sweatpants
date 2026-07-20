import { run } from "effection";
import { describe, expect, it } from "vitest";
import { appendTestTokens, completeTestBuffer } from './test-writer.ts'

import { createInMemoryBuffer } from "../in-memory-store.ts";
import { toOffsetString } from "../protocol-headers.ts";
import { createSSEEventStream } from "../sse-formatter.ts";

describe("sse-formatter", () => {
  it("formats pure AG-UI-compatible data events for stream tokens", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>("session-1");
      yield* appendTestTokens(buffer, ['{"type":"RUN_STARTED","threadId":"t","runId":"r"}']);

      const stream = createSSEEventStream(buffer, 0);
      const subscription = yield* stream;
      const first = yield* subscription.next();

      expect(first.done).toBe(false);
      expect(first.value).toContain(`id: ${toOffsetString(1)}`);
      expect(first.value).toContain('data: {"type":"RUN_STARTED"');
      expect(first.value).not.toContain("event: control");
      expect(first.value).not.toContain("streamNextOffset");
    });
  });

  it("ends without emitting control data when buffer completes", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>("session-2");
      yield* appendTestTokens(buffer, ['{"type":"RUN_STARTED","threadId":"t","runId":"r"}']);

      const stream = createSSEEventStream(buffer, 0);
      const subscription = yield* stream;

      const first = yield* subscription.next();
      expect(first.done).toBe(false);

      yield* completeTestBuffer(buffer);

      const second = yield* subscription.next();
      expect(second.done).toBe(true);
    });
  });
});
