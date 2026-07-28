import { type Scope, type Subscription } from "effection";
import type { TokenBuffer, TokenFrame } from "@sweatpants/durable-streams";
import { createPullStream } from "@sweatpants/durable-streams";

/**
 * Creates a pull-based Web ReadableStream from a TokenBuffer.
 *
 * This adapter is intentionally local to the durable Turn runtime: it owns the
 * TokenBuffer-to-NDJSON protocol boundary while the generic stream-bridge
 * remains an agent-host composition dependency.
 */
export function createWebStreamFromBuffer(
  scope: Scope,
  buffer: TokenBuffer<string>,
  startLSN = 0,
): ReadableStream<Uint8Array> {
  const stream = createPullStream(buffer, startLSN);
  const encoder = new TextEncoder();
  let subscription: Subscription<TokenFrame<string>, void> | null = null;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start() {
      subscription = await scope.run(function* () {
        return yield* stream;
      });
    },

    async pull(controller) {
      if (!subscription || closed) {
        controller.close();
        return;
      }
      try {
        const result = await scope.run(function* () {
          return yield* subscription!.next();
        });
        if (result.done) {
          closed = true;
          controller.close();
        } else {
          controller.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
        }
      } catch (error) {
        closed = true;
        controller.error(error);
      }
    },

    cancel() {
      closed = true;
    },
  });
}
