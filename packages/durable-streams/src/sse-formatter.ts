import { resource, type Operation, type Stream } from "effection";

import { createPullStream } from "./pull-stream.ts";
import { toOffsetString } from "./protocol-headers.ts";
import type { TokenBuffer } from "./types.ts";

function formatSSEData(payload: string, id: number): string {
  return `id: ${toOffsetString(id)}\ndata: ${payload}\n\n`;
}

export function createSSEEventStream<T>(
  buffer: TokenBuffer<T>,
  startLSN: number,
): Stream<string, void> {
  return resource(function* (provide) {
    const pullStream = yield* createPullStream(buffer, startLSN);
    let cursor = startLSN;
    let emittedClosed = false;

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (emittedClosed) {
          return { done: true, value: undefined };
        }

        const result = yield* pullStream.next();
        if (result.done) {
          emittedClosed = true;
          return { done: true, value: undefined };
        }

        const frame = result.value;
        cursor = frame.lsn;

        return {
          done: false,
          value: formatSSEData(
            typeof frame.token === "string" ? frame.token : JSON.stringify(frame.token),
            cursor,
          ),
        };
      },
    });
  });
}
