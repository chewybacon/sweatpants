import { describe, expect, it } from "vitest";
import { run, sleep } from "effection";
import { createChatSession } from "../create-session.ts";
import type { ChatFetch } from "../options.ts";

/**
 * Regression coverage: an in-flight request must be a child of the session
 * resource. Destroying the session mid-request has to abort the underlying
 * fetch (structured teardown) and still fire onRequestFinished. A detached
 * request scope would leave the fetch running with no owner.
 */
describe("chat session teardown", () => {
  it("aborts an in-flight request and settles lifecycle callbacks when the session is destroyed", async () => {
    let fetchSignal: AbortSignal | undefined;
    let fetchStarted: (() => void) | undefined;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let requestFinished = false;
    let resolveRequestFinished: () => void;
    const requestFinishedPromise = new Promise<void>((resolve) => {
      resolveRequestFinished = () => {
        requestFinished = true;
        resolve();
      };
    });

    // A streaming response whose body never ends: the request stays in-flight
    // until it is aborted by teardown.
    const hangingFetch: ChatFetch = async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      fetchStarted!();
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Never enqueue, never close.
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      );
    };

    await run(function* () {
      const session = yield* createChatSession({
        fetch: hangingFetch,
        onRequestFinished() {
          resolveRequestFinished();
        },
      });
      yield* sleep(0);
      session.dispatch({ type: "send", content: "hello" });
      // Wait until the request is genuinely in flight, then return: leaving
      // this operation destroys the session resource mid-request.
      yield* until(fetchStartedPromise);
    });

    await withTimeout(requestFinishedPromise, "onRequestFinished after session teardown");
    expect(requestFinished).toBe(true);
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(true);
  });
});

function* until<T>(promise: Promise<T>) {
  let settled: { value: T } | undefined;
  void promise.then((value) => {
    settled = { value };
  });
  while (!settled) {
    yield* sleep(1);
  }
  return settled.value;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
