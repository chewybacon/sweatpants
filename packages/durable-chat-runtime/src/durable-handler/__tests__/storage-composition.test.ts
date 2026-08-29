import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScope, run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { createProjectionTokenKeyring } from "../../projection-tokens.ts";
import { createDurableChatEndpoints } from "../handler.ts";
import { createProgramDriverJournalStore } from "../program-driver-journal.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function historyInput(conversationId: string) {
  return {
    conversationId,
    request: new Request(`http://localhost/api/chat/${conversationId}/history:page`, {
      method: "POST",
      body: JSON.stringify({ cursor: "invalid" }),
    }),
  };
}

function config(path: string, onJournal: () => void) {
  return {
    storage: { kind: "sqlite" as const, path },
    createProgramDriverJournalStore(
      executionStore: Parameters<typeof createProgramDriverJournalStore>[0]["executionStore"],
    ) {
      onJournal();
      return createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("sqlite-chat-storage-test", [
          { keyId: "test", secret: "sqlite-chat-storage-test-key-material" },
        ]),
        executionStore,
      });
    },
    projectionTokens: createProjectionTokenKeyring("sqlite-chat-storage-projection-key"),
    *authorizeHistoryRead() {
      return "authorized" as const;
    },
  };
}

describe("durable chat SQLite composition", () => {
  it("opens lazily once per bound scope and closes with the scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-chat-sqlite-"));
    roots.push(root);
    const path = join(root, "nested", "chat.sqlite");
    let journalCount = 0;
    const endpoints = createDurableChatEndpoints(config(path, () => journalCount++));

    await expect(import("node:fs/promises").then(({ stat }) => stat(path))).rejects.toThrow();

    const [scope, closeScope] = createScope();
    const pageHistory = endpoints.pageHistory.withScope(scope);
    const [first, second] = await Promise.all([
      pageHistory(historyInput("first")),
      pageHistory(historyInput("second")),
    ]);

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(journalCount).toBe(1);

    await closeScope();
    await closeScope();

    const reopened = await run(function* () {
      return yield* openBetterSqliteStorage(path, { migrate: true });
    });
    await run(() => reopened.close());
  });

  it("memoizes a failed open and never constructs a fallback journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-chat-sqlite-failure-"));
    roots.push(root);
    const parentFile = join(root, "not-a-directory");
    await writeFile(parentFile, "sentinel", "utf8");
    const path = join(parentFile, "chat.sqlite");
    let journalCount = 0;
    const endpoints = createDurableChatEndpoints(config(path, () => journalCount++));
    const [scope, closeScope] = createScope();
    const pageHistory = endpoints.pageHistory.withScope(scope);

    await expect(pageHistory(historyInput("first"))).rejects.toThrow();
    await expect(pageHistory(historyInput("second"))).rejects.toThrow();
    expect(journalCount).toBe(0);

    await closeScope();
  });
});
