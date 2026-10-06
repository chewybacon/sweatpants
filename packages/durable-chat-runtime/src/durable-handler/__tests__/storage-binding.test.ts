import { openChatStorageDatabase, openScopedSqliteChatStorage } from "../storage-node.ts";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScope } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { BetterSqliteDatabase as Database } from "@sweatpants/storage-sqlite/better-sqlite3";
import {
  assertChatSqliteStorageVariant,
  chatStorageFromEnv,
  type ChatStorageConfig,
} from "../storage.ts";
import { createDurableChatEndpoints } from "../handler.ts";
import { createProgramDriverJournalStore } from "../program-driver-journal.ts";
import { createProjectionTokenKeyring } from "../../projection-tokens.ts";

const roots: string[] = [];
const closables: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const closable of closables.splice(0).reverse()) {
    try {
      closable.close();
    } catch {
      // Teardown best effort.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rmSync(root, { recursive: true, force: true })));
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storage-binding-runtime-"));
  roots.push(root);
  return root;
}

function tempFile(name: string): string {
  return join(roots[roots.length - 1]!, name);
}

function historyRequest(): { conversationId: string; request: Request } {
  return {
    conversationId: "conversation-under-test",
    request: new Request("http://localhost/api/chat/history:page", {
      method: "POST",
      body: JSON.stringify({ cursor: null }),
    }),
  } as never;
}

function endpointsConfig(
  storage: ChatStorageConfig,
): Parameters<typeof createDurableChatEndpoints>[0] {
  return {
    storage,
    createProgramDriverJournalStore(
      executionStore: Parameters<typeof createProgramDriverJournalStore>[0]["executionStore"],
    ) {
      return createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("storage-binding-test", [
          { keyId: "test", secret: "storage-binding-test-key-material" },
        ]),
        executionStore,
      });
    },
    projectionTokens: createProjectionTokenKeyring("storage-binding-test-projection-key"),
    *authorizeHistoryRead() {
      return "authorized" as const;
    },
  } as Parameters<typeof createDurableChatEndpoints>[0];
}

describe("chat sqlite storage variant", () => {
  it("rejects contradictory and absent binding sources (TC-006)", () => {
    const binding = new Database(":memory:");
    closables.push(binding);

    const both = { kind: "sqlite", path: "/tmp/x.sqlite", database: binding };
    expect(() =>
      assertChatSqliteStorageVariant(both as unknown as ChatStorageConfig & { kind: "sqlite" }),
    ).toThrow(
      "Durable chat storage configuration accepts either a database binding or a path, not both",
    );

    const neither = { kind: "sqlite" };
    expect(() =>
      assertChatSqliteStorageVariant(neither as unknown as ChatStorageConfig & { kind: "sqlite" }),
    ).toThrow("Durable chat storage configuration requires a SQLite path or a database binding");

    // Composition-level validation fires the same errors.
    expect(() =>
      createDurableChatEndpoints(endpointsConfig(both as unknown as ChatStorageConfig)),
    ).toThrow(
      "Durable chat storage configuration accepts either a database binding or a path, not both",
    );
    expect(() =>
      createDurableChatEndpoints(endpointsConfig(neither as unknown as ChatStorageConfig)),
    ).toThrow("Durable chat storage configuration requires a SQLite path or a database binding");
  });

  it("converts storage selections into caller-owned bindings (TC-008)", () => {
    newRoot();
    const path = tempFile("env.sqlite");

    const fromPath = openChatStorageDatabase({ kind: "sqlite", path });
    expect(fromPath).not.toBeNull();
    closables.push(fromPath!);
    expect(fromPath!.pragma("journal_mode", { simple: true })).toBe("wal");

    expect(openChatStorageDatabase({ kind: "memory" })).toBeNull();
    expect(
      openChatStorageDatabase({
        kind: "custom",
        conversationStore: {} as never,
        executionStore: {} as never,
      }),
    ).toBeNull();

    // A handed-in binding passes through unchanged.
    const binding = new Database(":memory:");
    closables.push(binding);
    expect(openChatStorageDatabase({ kind: "sqlite", database: binding })).toBe(binding);

    // The env resolver itself is unchanged: path selection still resolves.
    const selection = chatStorageFromEnv({
      defaultPath: path,
      env: { SWEATPANTS_DB_PATH: path },
    });
    expect(selection).toEqual({ kind: "sqlite", path });
  });

  it("keeps the binding open across scoped composition (TC-007)", async () => {
    newRoot();
    const path = tempFile("scoped.sqlite");
    const binding = new Database(path);
    closables.push(binding);

    const [scope, closeScope] = createScope();
    const resolved = await openScopedSqliteChatStorage(
      { kind: "sqlite", database: binding },
      scope,
    );
    expect(resolved.conversationStore).toBeDefined();
    expect(resolved.executionStore).toBeDefined();

    await closeScope();
    // The kernel never closes a caller-owned binding (REQ-005).
    expect(binding.open).toBe(true);
  });

  it("performs no filesystem setup for a handed-in binding (TC-007)", async () => {
    const root = newRoot();
    const binding = new Database(join(root, "app.sqlite"));
    closables.push(binding);

    const endpoints = createDurableChatEndpoints(
      endpointsConfig({ kind: "sqlite", database: binding }),
    );
    const [scope, closeScope] = createScope();
    const history = endpoints.pageHistory.withScope(scope);
    await history(historyRequest()).catch(() => undefined);
    await closeScope();

    // Composition added nothing: only the binding's own sqlite files exist.
    const entries = readdirSync(root, { withFileTypes: true });
    expect(entries.every((entry) => !entry.isDirectory())).toBe(true);
    expect(binding.open).toBe(true);
  });

  it("memoizes a failing open per scope and retries on a new scope (TC-007)", async () => {
    newRoot();
    const path = tempFile("corrupt.sqlite");
    writeFileSync(path, "definitely not sqlite".repeat(20));
    const binding = new Database(path);
    closables.push(binding);

    const endpoints = createDurableChatEndpoints(
      endpointsConfig({ kind: "sqlite", database: binding }),
    );

    const [firstScope, closeFirst] = createScope();
    const firstHistory = endpoints.pageHistory.withScope(firstScope);
    const firstError = await firstHistory(historyRequest())
      .then(() => null)
      .catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(Error);

    // Same scope: the failure is memoized (no re-open attempt).
    const secondError = await firstHistory(historyRequest())
      .then(() => null)
      .catch((error: unknown) => error);
    expect(secondError).toBeInstanceOf(Error);
    await closeFirst();

    // A fresh scope attempts the open again (and fails again on corruption).
    const [secondScope, closeSecond] = createScope();
    const thirdHistory = endpoints.pageHistory.withScope(secondScope);
    const thirdError = await thirdHistory(historyRequest())
      .then(() => null)
      .catch((error: unknown) => error);
    expect(thirdError).toBeInstanceOf(Error);
    await closeSecond();
  });
});
