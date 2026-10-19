import { run } from "effection";
import { describe, expect, it } from "vitest";
import { parseNDJSON } from "@sweatpants/chat-core";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    },
  });
}

async function collect<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<T[]> {
  return run(function* () {
    const values: T[] = [];
    const subscription = yield* parseNDJSON<T>(body, signal ? { signal } : undefined);
    while (true) {
      const next = yield* subscription.next();
      if (next.done) {
        return values;
      }
      values.push(next.value);
    }
  });
}

describe("parseNDJSON public codec", () => {
  it("parses multiple records, blank lines, and a final unterminated record", async () => {
    await expect(
      collect<{ id: number }>(streamOf(['{"id":1}\n\n{"id":2}\n', '{"id":3}'])),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("reassembles records across arbitrary byte chunks", async () => {
    const encoded = '{"type":"text","content":"hello"}\n{"type":"done"}\n';
    await expect(collect(streamOf([...encoded]))).resolves.toEqual([
      { type: "text", content: "hello" },
      { type: "done" },
    ]);
  });

  it("rejects malformed complete records", async () => {
    await expect(collect(streamOf(['{"invalid" nope}\n']))).rejects.toThrow();
  });

  it("rejects a truncated final record", async () => {
    await expect(collect(streamOf(['{"truncated":']))).rejects.toThrow();
  });

  it("returns no records for an empty body", async () => {
    await expect(collect(streamOf([]))).resolves.toEqual([]);
  });

  it("honors cancellation before reading", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(collect(streamOf(['{"id":1}\n']), abort.signal)).resolves.toEqual([]);
  });

  it("stops after cancellation during a stream", async () => {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === 0) {
          controller.enqueue(encoder.encode('{"id":1}\n'));
          index += 1;
          return;
        }
        abort.abort();
        controller.enqueue(encoder.encode('{"id":2}\n'));
        controller.close();
      },
    });
    const values = await collect<{ id: number }>(body, abort.signal);
    expect(values).toEqual([{ id: 1 }]);
  });
});
