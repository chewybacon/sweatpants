// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("opens the configured file lazily and reopens it in a new generation", async () => {
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
    const first = createChatApplication({ handler: firstEndpoints.postChat });
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(databasePath)),
    ).rejects.toThrow();

    const firstResponse = await first.handleEndpoint(
      firstEndpoints.pageHistory,
      historyRequest("/api/chat/sqlite-app-smoke/history:page"),
    );
    expect(firstResponse.status).toBe(400);
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(databasePath)),
    ).resolves.toBeDefined();
    await first.close();

    const secondEndpoints = createYoChatEndpoints();
    const second = createChatApplication({ handler: secondEndpoints.postChat });
    const secondResponse = await second.handleEndpoint(
      secondEndpoints.pageHistory,
      historyRequest("/api/chat/sqlite-app-smoke/history:page"),
    );
    expect(secondResponse.status).toBe(400);
    await second.close();
  });

  it("returns a safe setup error without replacing an invalid SQLite path", async () => {
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

    const [{ createYoChatEndpoints }, { createChatApplication }] = await Promise.all([
      import("../server/chat-handler.ts"),
      import("@sweatpants/agent-host/server"),
    ]);
    const endpoints = createYoChatEndpoints();
    const application = createChatApplication({ handler: endpoints.postChat });
    const response = await application.handleEndpoint(
      endpoints.pageHistory,
      historyRequest("/api/chat/sqlite-app-smoke/history:page"),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      message: "Chat application setup failed",
    });
    await expect(
      import("node:fs/promises").then(({ readFile }) => readFile(parentFile, "utf8")),
    ).resolves.toBe("sentinel");
    await application.close();
  });
});
