import type { DatabaseSync } from "node:sqlite";
import { createReadableStream, type Runtime, type Stream } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import { chatCommand } from "../chat/contract.ts";
import { createDemoRun } from "./chat-run.ts";
import type { ChatDemo } from "./chat-demo.ts";

/** The route chooses request ownership explicitly. Cancelling another reader of
 * the run itself has no effect on its owner. No background execution is implied. */
export function createDemoHandlers<Y>(
  demo: ChatDemo,
  runtime: Runtime<Y>,
  openDatabase: () => DatabaseSync,
  sampling: (publish: (text: string) => void) => Promise<ChatSampling<Y>>,
) {
  async function handle({ request, params }: { request: Request; params: { thread: string } }) {
    const thread = params.thread;
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(thread)) {
      return Response.json({ error: "Invalid thread" }, { status: 400 });
    }
    if (
      request.method !== "GET" &&
      request.headers.has("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return new Response(null, { status: 403 });
    }
    const parsed =
      request.method === "GET"
        ? undefined
        : chatCommand.safeParse(await request.json().catch(() => null));
    if (parsed && !parsed.success) {
      return Response.json({ error: "Invalid command" }, { status: 400 });
    }
    const command = parsed?.data;
    const run = createDemoRun(demo, runtime, openDatabase, sampling, thread, command);
    const encoder = new TextEncoder();
    // The request owns production; the web reader only pulls delivery.
    // Start inside the delivery scope so an unread/cancelled response starts no work.
    const source: Stream<Uint8Array, void, Y> = {
      *[Symbol.iterator]() {
        const owner = runtime.start(() => run.run(request.signal));
        // Failure is represented on the event stream. Keep the owner rejection observed.
        void owner.result.catch(() => undefined);
        yield* runtime.composition.ensure(function* () {
          yield* runtime.fromPromise(() => owner.cancel());
        });
        const events = yield* run.events();
        return {
          *next() {
            const item = yield* events.next();
            if (item.done) {
              return item;
            }
            return {
              done: false as const,
              value: encoder.encode(`data: ${JSON.stringify(item.value)}\n\n`),
            };
          },
        };
      },
    };
    return new Response(createReadableStream(runtime, source), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }
  return {
    GET: handle,
    POST: handle,
    ANY: () => new Response(null, { status: 405, headers: { Allow: "GET, POST" } }),
  };
}
