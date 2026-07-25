import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";

import { createStudioDevelopmentRuntime } from "./development-api.ts";
import {
  createScriptedStudioModelProvider,
  createStudioDurableChatApplication,
} from "./durable-chat-application.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("yo-studio durable chat HTTP projection", () => {
  it("drives workspace child programs through createDurableChatHandler", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-studio-chat-handler-"));
    roots.push(root);
    const runtime = await run(function* () {
      return yield* createStudioDevelopmentRuntime(root);
    });
    const application = createStudioDurableChatApplication({
      ...runtime,
      modelProvider: createScriptedStudioModelProvider(() =>
        runtime.workspace.currentWorkspaceVersion(),
      ),
    });
    try {
      const response = await application.handle(
        new Request("http://localhost/api/chat?conversationId=yo-studio-test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: "yo-studio-test",
            messages: [{ id: "user-1", role: "user", content: "Create demo.txt and test it" }],
            enabledTools: true,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const transcript = await response.text();
      expect(transcript).toContain("workspace_write");
      expect(transcript).toContain("workspace_test");
      expect(transcript).toContain("Created demo.txt and the declared test script passed.");

      const refreshed = await application.handle(
        new Request("http://localhost/api/chat?conversationId=yo-studio-test", {
          method: "GET",
        }),
      );
      expect(refreshed.status).toBe(200);
      await expect(refreshed.text()).resolves.toContain(
        "Created demo.txt and the declared test script passed.",
      );
    } finally {
      await application.close();
    }
  });

  it("propagates one conversation affinity through every workspace child", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-studio-chat-affinity-"));
    roots.push(root);
    const runtime = await run(function* () {
      return yield* createStudioDevelopmentRuntime(root);
    });
    const affinities: Array<{ readonly kind: string; readonly key: string }> = [];
    const application = createStudioDurableChatApplication({
      resolveWorkspace: function* (execution) {
        affinities.push(execution.affinity);
        return { connector: runtime.connector, fence: runtime.fence };
      },
      modelProvider: createScriptedStudioModelProvider(() =>
        runtime.workspace.currentWorkspaceVersion(),
      ),
    });
    try {
      const response = await application.handle(
        new Request("http://localhost/api/chat?conversationId=shared-workspace-conversation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: "shared-workspace-conversation",
            messages: [{ id: "user-1", role: "user", content: "Create demo.txt and test it" }],
            enabledTools: true,
          }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(affinities.length).toBeGreaterThanOrEqual(3);
      expect(affinities).toEqual(
        affinities.map(() => ({ kind: "conversation", key: "shared-workspace-conversation" })),
      );
    } finally {
      await application.close();
    }
  });
});
