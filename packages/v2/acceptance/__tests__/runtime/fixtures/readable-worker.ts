// Workerd fixture: the same bridge under both native runtimes, served as a Response body.
import { createRuntime as createEffectRuntime } from "@sweatpan.ts/runtime-effect";
import { createRuntime as createEffectionRuntime } from "@sweatpan.ts/runtime-effection";
import { createBufferedSignal, createReadableStream, type Runtime } from "@sweatpan.ts/runtime";

const released: Record<string, boolean> = {};

function respond<Y>(runtime: Runtime<Y>, mode: string): Response {
  const buffer = createBufferedSignal<string, void, Y>(runtime);
  const encoder = new TextEncoder();
  // Producer runs eagerly and independently of the reader's pace.
  const producer = runtime.start(function* () {
    for (const word of ["Hel", "lo", ", ", "wor", "ld"]) {
      buffer.send(word);
      yield* runtime.sleep(mode === "slow" ? 50 : 1);
    }
    buffer.close();
  });
  void producer.result.catch((error: unknown) => buffer.fail(error));
  const key = `${runtime.name.toLowerCase()}:${mode}`;
  released[key] = false;
  const source = {
    *[Symbol.iterator]() {
      yield* runtime.composition.ensure(function* () {
        released[key] = true;
      });
      const reader = yield* buffer.from(0, (previous, next) => previous + next);
      return {
        *next(): Generator<Y, IteratorResult<Uint8Array, void>, any> {
          const item = yield* reader.next();
          return item.done ? item : { done: false, value: encoder.encode(`${item.value}\n`) };
        },
      };
    },
  };
  return new Response(createReadableStream(runtime, source), {
    headers: { "content-type": "text/plain" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runtime: Runtime<any> =
      url.searchParams.get("runtime") === "effect"
        ? createEffectRuntime()
        : createEffectionRuntime();
    if (url.pathname === "/released") {
      return Response.json(released);
    }
    if (url.pathname === "/slow-consumer") {
      // Consume inside workerd at a pace slower than production.
      const reader = respond(runtime, "slow").body!.getReader();
      const decoder = new TextDecoder();
      await new Promise((resolve) => setTimeout(resolve, 400));
      let text = "";
      while (true) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        text += decoder.decode(item.value, { stream: true });
      }
      return Response.json(text.split("\n").filter(Boolean));
    }
    return respond(runtime, url.searchParams.get("mode") ?? "fast");
  },
};
