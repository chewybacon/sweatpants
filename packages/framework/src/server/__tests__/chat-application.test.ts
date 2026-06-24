import { describe, expect, it } from "vitest";
import { createContext, ensure, sleep, type Operation, type Subscription } from "effection";
import { createChatApplication, createChatHandler } from "../index.ts";
import { createStreamingHandler } from "../../handler/streaming.ts";

function oneShotSubscription(value: string): Subscription<string, void> {
  let done = false;
  return {
    *next(): Operation<IteratorResult<string, void>> {
      if (done) return { done: true, value: undefined };
      done = true;
      return { done: false, value };
    },
  };
}

async function readResponseText(response: Response): Promise<string> {
  return (await response.text()).trim();
}

describe("createChatApplication", () => {
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
  it("rejects the legacy hook-array config at type level", () => {
    const legacyInitializerHooksKey = "initializerHooks" as const;

    // @ts-expect-error legacy hook-array config is intentionally removed from public config.
    const _legacyConfig = {
      [legacyInitializerHooksKey]: [],
    } satisfies Parameters<typeof createChatHandler>[0];

    expect(_legacyConfig).toBeTruthy();
  });
});
