// @vitest-environment node
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { BetterSqliteDatabase } from "@sweatpants/storage-sqlite/better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const originalStorage = process.env["SWEATPANTS_STORAGE"];
const originalPath = process.env["SWEATPANTS_DB_PATH"];
const originalSecret = process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"];

afterEach(async () => {
  vi.doUnmock("@/env");
  vi.resetModules();
  if (originalStorage === undefined) delete process.env["SWEATPANTS_STORAGE"];
  else process.env["SWEATPANTS_STORAGE"] = originalStorage;
  if (originalPath === undefined) delete process.env["SWEATPANTS_DB_PATH"];
  else process.env["SWEATPANTS_DB_PATH"] = originalPath;
  if (originalSecret === undefined) delete process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"];
  else process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"] = originalSecret;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function historyRequest(path: string) {
  return {
    conversationId: "sqlite-app-smoke",
    request: new Request(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify({ cursor: "invalid" }),
    }),
  };
}

describe("yo-chat SQLite application wiring", () => {
  it("creates the binding at composition, initializes on first request, and reopens in a new generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-chat-sqlite-"));
    roots.push(root);
    const databasePath = join(root, "authority", "yo-chat.sqlite");
    delete process.env["SWEATPANTS_STORAGE"];
    process.env["SWEATPANTS_DB_PATH"] = databasePath;
    process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"] =
      "yo-chat-sqlite-test-capability-secret-at-least-32-bytes";
    vi.doMock("@/env", () => ({
      env: {
        PROGRAM_DRIVER_CAPABILITY_SECRET: "yo-chat-sqlite-test-capability-secret-at-least-32-bytes",
        SWEATPANTS_DB_PATH: databasePath,
      },
    }));

    const [{ createYoChatEndpoints }, { createChatApplication }] = await Promise.all([
      import("../server/chat-handler.ts"),
      import("@sweatpants/agent-host/server"),
    ]);
    const firstEndpoints = createYoChatEndpoints();

    // The app owns the binding: the file exists at composition time.
    await expect(stat(databasePath)).resolves.toBeDefined();

    // Kernel initialization stays lazy: no authority tables until the first request.
    const raw = new BetterSqliteDatabase(databasePath, { readonly: true });
    const tableCountBefore = (
      raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sp_conversation_heads'",
        )
        .get() as { n: number }
    ).n;
    raw.close();
    expect(tableCountBefore).toBe(0);

    const first = createChatApplication({ handler: firstEndpoints.postChat });
    const firstResponse = await first.handleEndpoint(
      firstEndpoints.pageHistory,
      historyRequest("/api/chat/sqlite-app-smoke/history:page"),
    );
    expect(firstResponse.status).toBe(400);
    await first.close();

    // A new generation composes fresh endpoints over the same file.
    const secondEndpoints = createYoChatEndpoints();
    const second = createChatApplication({ handler: secondEndpoints.postChat });
    const secondResponse = await second.handleEndpoint(
      secondEndpoints.pageHistory,
      historyRequest("/api/chat/sqlite-app-smoke/history:page"),
    );
    expect(secondResponse.status).toBe(400);
    await second.close();
  });

  it("fails composition loudly for an unopenable SQLite path, leaving the sentinel untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-chat-sqlite-failure-"));
    roots.push(root);
    const parentFile = join(root, "not-a-directory");
    await writeFile(parentFile, "sentinel", "utf8");
    delete process.env["SWEATPANTS_STORAGE"];
    process.env["SWEATPANTS_DB_PATH"] = join(parentFile, "yo-chat.sqlite");
    process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"] =
      "yo-chat-sqlite-test-capability-secret-at-least-32-bytes";
    vi.doMock("@/env", () => ({
      env: {
        PROGRAM_DRIVER_CAPABILITY_SECRET: "yo-chat-sqlite-test-capability-secret-at-least-32-bytes",
        SWEATPANTS_DB_PATH: join(parentFile, "yo-chat.sqlite"),
      },
    }));

    const [{ createYoChatEndpoints }] = [await import("../server/chat-handler.ts")];

    // Fail closed at startup: composition refuses to build on an unopenable
    // path instead of hiding the failure until the first request.
    expect(() => createYoChatEndpoints()).toThrow();
    await expect(readFile(parentFile, "utf8")).resolves.toBe("sentinel");
  });
});
