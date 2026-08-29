import { createScope, run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { chatStorageFromEnv } from "../storage.ts";
import { resolveDurableChatComposition } from "../configuration.ts";
import { createDurableChatEndpoints } from "../handler.ts";
import type { DurableChatHandlerConfig } from "../types.ts";

const SECRET = "configuration-test-secret-material-32b";

describe("chatStorageFromEnv", () => {
  it("defaults to SQLite at the provided path", () => {
    expect(chatStorageFromEnv({ defaultPath: "/tmp/app.sqlite", env: {} })).toEqual({
      kind: "sqlite",
      path: "/tmp/app.sqlite",
    });
  });

  it("accepts a file URL default path", () => {
    const config = chatStorageFromEnv({
      defaultPath: new URL("file:///tmp/url-app.sqlite"),
      env: {},
    });
    expect(config).toEqual({ kind: "sqlite", path: "/tmp/url-app.sqlite" });
  });

  it("honors SWEATPANTS_DB_PATH, explicit memory, and the profile option", () => {
    expect(
      chatStorageFromEnv({
        defaultPath: "/tmp/app.sqlite",
        env: { SWEATPANTS_DB_PATH: "/tmp/override.sqlite" },
      }),
    ).toEqual({ kind: "sqlite", path: "/tmp/override.sqlite" });
    expect(
      chatStorageFromEnv({
        defaultPath: "/tmp/app.sqlite",
        env: { SWEATPANTS_STORAGE: "memory" },
        profile: "low",
      }),
    ).toEqual({ kind: "memory", profile: "low" });
  });

  it("fails closed on unknown, empty, and contradictory settings", () => {
    expect(() =>
      chatStorageFromEnv({ defaultPath: "/tmp/app.sqlite", env: { SWEATPANTS_STORAGE: "sqlite" } }),
    ).toThrow(/only accepts "memory"/);
    expect(() =>
      chatStorageFromEnv({ defaultPath: "/tmp/app.sqlite", env: { SWEATPANTS_DB_PATH: "  " } }),
    ).toThrow(/must not be empty/);
    expect(() =>
      chatStorageFromEnv({
        defaultPath: "/tmp/app.sqlite",
        env: { SWEATPANTS_STORAGE: "memory", SWEATPANTS_DB_PATH: "/tmp/x.sqlite" },
      }),
    ).toThrow(/cannot be combined/);
  });
});

describe("resolveDurableChatComposition", () => {
  const storage = { kind: "memory" } as const;

  it("derives journal store, projection tokens, and authorized history reads", async () => {
    const composition = resolveDurableChatComposition({
      name: "config-test",
      secret: SECRET,
      storage,
    });
    expect(composition.projectionTokens.activeKey.byteLength).toBeGreaterThanOrEqual(32);
    const journalStore = composition.createJournalStore(createMemoryExecutionStore());
    await expect(run(() => journalStore.open("conversation-1"))).resolves.toBeDefined();
    await expect(
      run(() => composition.authorizeHistoryRead(new Request("http://localhost/"), "c-1")),
    ).resolves.toBe("authorized");
  });

  it("rejects short secrets, missing names, and incomplete explicit compositions", () => {
    expect(() =>
      resolveDurableChatComposition({ name: "config-test", secret: "too-short", storage }),
    ).toThrow(/at least 32 UTF-8 bytes/);
    expect(() => resolveDurableChatComposition({ name: "  ", secret: SECRET, storage })).toThrow(
      /non-empty `name`/,
    );
    expect(() =>
      resolveDurableChatComposition({ storage } as unknown as DurableChatHandlerConfig),
    ).toThrow(/either \{ name, secret \}/);
  });

  it("rejects programs combined with an explicit journal store builder", () => {
    const config = {
      name: "config-test",
      secret: SECRET,
      storage,
      programs: [{ artifacts: { catalog: [] } }],
      createProgramDriverJournalStore: () => {
        throw new Error("unused");
      },
    } as unknown as DurableChatHandlerConfig;
    expect(() => resolveDurableChatComposition(config)).toThrow(/cannot be combined/);
  });
});

describe("durable chat endpoints inspection", () => {
  it("resolves one stable storage composition per scope", async () => {
    const endpoints = createDurableChatEndpoints({
      name: "config-test",
      secret: SECRET,
      storage: { kind: "memory" },
    });
    const [scope, closeScope] = createScope();
    try {
      const first = await endpoints.inspect(scope);
      const second = await endpoints.inspect(scope);
      expect(first.conversationStore).toBe(second.conversationStore);
      expect(first.executionStore).toBe(second.executionStore);
      expect(first.programDriverJournalStore).toBe(second.programDriverJournalStore);
    } finally {
      await closeScope();
    }
  });
});
