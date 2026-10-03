import { describe, expect, it } from "vitest";
import {
  call,
  createContext,
  ensure,
  resource,
  sleep,
  suspend,
  type Operation,
  type Subscription,
} from "effection";
import type { RecoverableSessionRegistry } from "@sweatpants/durable-streams";
import { createChatApp, createChatApplication, createChatHandler } from "../index.ts";
import { createStreamingHandler } from "@sweatpants/durable-chat-runtime/streaming";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";

function oneShotSubscription(value: string): Subscription<string, void> {
  let done = false;
  return {
    *next(): Operation<IteratorResult<string, void>> {
      if (done) {
        return { done: true, value: undefined };
      }
      done = true;
      return { done: false, value };
    },
  };
}

async function readResponseText(response: Response): Promise<string> {
  return (await response.text()).trim();
}

describe("createChatApplication", () => {
  it("owns durable writer work beyond requests and reclaims it on Host close", async () => {
    let registry: RecoverableSessionRegistry<string> | undefined;
    let writerStarted = false;
    let writerHalted = false;

    const handler = createStreamingHandler(function* () {
      if (!registry) {
        throw new Error("registry was not configured");
      }
      const source = resource<Subscription<string, void>>(function* (provide) {
        yield* provide({
          *next() {
            writerStarted = true;
            try {
              yield* suspend();
            } finally {
              writerHalted = true;
            }
            return { done: true, value: undefined };
          },
        });
      });
      yield* registry.acquire("host-owned-writer", { source });
      return oneShotSubscription("started");
    });

    const app = createChatApplication({
      setup: function* () {
        registry = (yield* setupInMemoryDurableStreams<string>()).registry;
      },
      handler,
      shutdownDeadlineMs: 0,
    });

    const response = await app.handle(new Request("http://localhost/chat"));
    expect(await readResponseText(response)).toBe("started");
    expect(writerStarted).toBe(true);
    expect(writerHalted).toBe(false);

    await app.close();
    expect(writerHalted).toBe(true);
  });

  it("waits for Host-owned writers to drain before destroying their scope", async () => {
    let registry: RecoverableSessionRegistry<string> | undefined;
    let releaseWriter!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerCompleted = false;

    const handler = createStreamingHandler(function* () {
      if (!registry) {
        throw new Error("registry was not configured");
      }
      const source = resource<Subscription<string, void>>(function* (provide) {
        yield* provide({
          *next() {
            yield* ensure(() => {
              writerCompleted = true;
            });
            yield* call(() => released);
            return { done: true, value: undefined };
          },
        });
      });
      yield* registry.acquire("drained-writer", { source });
      return oneShotSubscription("started");
    });

    const app = createChatApplication({
      setup: function* () {
        registry = (yield* setupInMemoryDurableStreams<string>()).registry;
      },
      handler,
      shutdownDeadlineMs: 1_000,
    });
    await readResponseText(await app.handle(new Request("http://localhost/chat")));

    let closeSettled = false;
    const closing = app.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseWriter();
    await closing;
    expect(writerCompleted).toBe(true);
  });

  it("runs Effection app setup once and exposes app context to request scopes", async () => {
    const AppValueContext = createContext<string>("test-app-value");
    let setupCount = 0;

    const handler = createStreamingHandler(function* () {
      const value = yield* AppValueContext.expect();
      return oneShotSubscription(value);
    });

    const app = createChatApplication({
      setup: function* () {
        setupCount++;
        yield* AppValueContext.set("from-app-scope");
      },
      handler,
    });

    try {
      const first = await app.handle(new Request("http://localhost/chat"));
      const second = await app.handle(new Request("http://localhost/chat"));

      expect(await readResponseText(first)).toBe("from-app-scope");
      expect(await readResponseText(second)).toBe("from-app-scope");
      expect(setupCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("deduplicates concurrent first setup", async () => {
    let setupCount = 0;

    const handler = createStreamingHandler(function* () {
      return oneShotSubscription("ok");
    });

    const app = createChatApplication({
      setup: function* () {
        setupCount++;
        yield* sleep(25);
      },
      handler,
    });

    try {
      const [first, second, third] = await Promise.all([
        app.handle(new Request("http://localhost/a")),
        app.handle(new Request("http://localhost/b")),
        app.handle(new Request("http://localhost/c")),
      ]);

      expect(await readResponseText(first)).toBe("ok");
      expect(await readResponseText(second)).toBe("ok");
      expect(await readResponseText(third)).toBe("ok");
      expect(setupCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("cleans up app resources on close and rejects handle after close", async () => {
    let cleanupCount = 0;

    const app = createChatApplication({
      setup: function* () {
        yield* ensure(() => {
          cleanupCount++;
        });
      },
      handler: createStreamingHandler(function* () {
        return oneShotSubscription("ok");
      }),
    });

    const response = await app.handle(new Request("http://localhost/chat"));
    expect(await readResponseText(response)).toBe("ok");

    await app.close();
    await app.close();

    expect(cleanupCount).toBe(1);
    await expect(app.handle(new Request("http://localhost/chat"))).rejects.toThrow(
      "ChatApplication is closed",
    );
  });

  it("returns a deterministic client-safe setup failure", async () => {
    let handlerCalled = false;
    const app = createChatApplication({
      setup: function* () {
        throw new Error("secret setup details");
      },
      handler: async () => {
        handlerCalled = true;
        return new Response("should not run");
      },
    });

    try {
      const response = await app.handle(new Request("http://localhost/chat"));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        type: "error",
        message: "Chat application setup failed",
      });
      expect(handlerCalled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("createChatHandler public config boundary", () => {
  it("rejects the removed hook-array config at type level", () => {
    const legacyInitializerHooksKey = "initializerHooks" as const;

    const _legacyConfig = {
      // @ts-expect-error removed hook-array config is intentionally removed from public config.
      [legacyInitializerHooksKey]: [],
    } satisfies Parameters<typeof createChatHandler>[0];

    expect(_legacyConfig).toBeTruthy();
  });
});

describe("createChatApp", () => {
  it("exposes endpoints and one stable storage composition until closed", async () => {
    const app = createChatApp({
      name: "chat-app-test",
      secret: "chat-app-test-secret-material-32-bytes",
      storage: { kind: "memory" },
    });
    expect(typeof app.handler).toBe("function");
    expect(typeof app.api.pageHistory).toBe("function");

    const first = await app.inspect();
    const second = await app.inspect();
    expect(second.conversationStore).toBe(first.conversationStore);
    expect(second.executionStore).toBe(first.executionStore);
    expect(second.programDriverJournalStore).toBe(first.programDriverJournalStore);

    await app.close();
    await expect(app.inspect()).rejects.toMatchObject({ name: "ChatApplicationClosedError" });
  });
});
