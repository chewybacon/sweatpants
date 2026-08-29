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
  it("drives workspace child programs through the POST chat endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-studio-chat-handler-"));
    roots.push(root);
    const runtime = await run(function* () {
      return yield* createStudioDevelopmentRuntime(root);
    });
    const application = createStudioDurableChatApplication({
      storage: { kind: "memory" },
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
            command: {
              type: "send-message",
              commandId: "00000000-0000-4000-8000-000000000001",
              issuedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              basisRevision: null,
              messageId: "user-1",
            },
            clientId: "yo-studio-test-client",
            conversationId: "yo-studio-test",
            runId: "run-yo-studio-test",
            userMessage: { id: "user-1", role: "user", content: "Create demo.txt and test it" },
            state: {},
            context: [],
            forwardedProps: {},
          }),
        }),
      );
      expect(response.status).toBe(200);
      const transcript = await response.text();
      expect(transcript).toContain("workspace_write");
      expect(transcript).toContain("workspace_test");
      expect(transcript).toContain("Created demo.txt and the declared test script passed.");

      const refreshed = await application.handleEndpoint(application.endpoints.readChat, {
        conversationId: "yo-studio-test",
        request: new Request("http://localhost/api/chat/yo-studio-test", {
          method: "GET",
        }),
      });
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
      storage: { kind: "memory" },
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
            command: {
              type: "send-message",
              commandId: "00000000-0000-4000-8000-000000000002",
              issuedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              basisRevision: null,
              messageId: "user-1",
            },
            clientId: "yo-studio-affinity-client",
            conversationId: "shared-workspace-conversation",
            runId: "run-shared-workspace-conversation",
            userMessage: { id: "user-1", role: "user", content: "Create demo.txt and test it" },
            state: {},
            context: [],
            forwardedProps: {},
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
