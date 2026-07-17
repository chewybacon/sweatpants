import { describe, expect, it } from "vitest";
import { advertiseCapability, defineAgent } from "@sweatpants/core";
import { parseForeignA2ASendResult, parseForeignA2ATask } from "@sweatpants/a2a";
import {
  createChatModelEffectRegistration,
  defineChatProgram,
  type ChatModelSampleOutputV2,
} from "../../lib/chat/authoring/index.ts";
import { startAgentHarness } from "../testing.ts";
import {
  createStandardA2AHost,
  serveAgent,
  standardA2A,
  type BoundStandardA2AHost,
} from "../index.ts";

function fixture() {
  let samples = 0;
  const chat = defineChatProgram({
    identity: { name: "standard-host.chat", version: "1" },
    systemPrompt: { text: "Answer deterministically", classification: "public" },
  });
  const definition = defineAgent({
    identity: { name: "standard-host", version: "1" },
    description: "Standard host fixture",
    conversation: chat,
    programs: { chat },
    advertisedCapabilities: {
      chat: advertiseCapability({
        id: "chat",
        name: "Chat",
        description: "Chat",
        tags: ["chat"],
        examples: ["hello"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        authorization: "chat-users",
      }),
    },
  });
  const model = createChatModelEffectRegistration({
    allowedClassifications: ["public"],
    *sample(request): Generator<never, ChatModelSampleOutputV2, never> {
      samples += 1;
      const latest = request.messages.at(-1)!;
      return {
        message: {
          id: `answer-${samples}`,
          role: "assistant",
          parts: [
            {
              value: `answer:${String(latest.parts[0]?.value)}`,
              provenance: { classifications: [], sourceDigests: [] },
            },
          ],
        },
        calls: [],
        artifacts: [],
      };
    },
  });
  const served = serveAgent(
    definition,
    standardA2A({
      deployment: {
        interfaceUrl: "http://127.0.0.1:43210/a2a",
        insecureLoopbackDevelopment: true,
      },
      handlers: [model],
      capabilityBindings: {},
      host: createStandardA2AHost({
        authenticate(request) {
          return request.headers.get("authorization") === "Bearer good"
            ? { principalId: "alice", tenantId: "tenant-a" }
            : undefined;
        },
      }),
    }),
  );
  return { host: served.host as BoundStandardA2AHost, samples: () => samples };
}

function message(messageId: string, text: string, contextId?: string, references?: string[]) {
  return {
    messageId,
    role: "user" as const,
    parts: [{ text }],
    ...(contextId ? { contextId } : {}),
    ...(references ? { referenceTaskIds: references } : {}),
  };
}

const principal = { principalId: "alice", tenantId: "tenant-a" } as const;

describe("journal-backed standard A2A host", () => {
  it("creates immutable per-turn tasks, preserves context and explicit lineage", async () => {
    const { host, samples } = fixture();
    const first = await host.sendMessage(message("m-1", "first"), principal);
    expect(first.status.state).toBe("completed");
    expect(first.history).toHaveLength(2);

    const second = await host.sendMessage(
      message("m-2", "second", first.contextId, [first.id, first.id]),
      principal,
    );
    expect(second.id).not.toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(second.metadata).toMatchObject({ referenceTaskIds: [first.id] });
    expect((await host.getTask(first.id, principal)).status.state).toBe("completed");
    expect(samples()).toBe(2);

    const evidence = await host.evidence(first.contextId!, principal);
    expect(evidence.acceptedMessages).toBe(2);
    expect(evidence.tasks.map((task) => task.referenceTaskIds)).toEqual([[], [first.id]]);
    expect(evidence.journal.filter((item) => item.type === "TaskClosed")).toHaveLength(2);
  });

  it("reconciles identical message retries and rejects conflicting reuse", async () => {
    const { host, samples } = fixture();
    const first = await host.sendMessage(message("same", "one"), principal);
    const retry = await host.sendMessage(message("same", "one", first.contextId), principal);
    expect(retry.id).toBe(first.id);
    expect(samples()).toBe(1);
    await expect(
      host.sendMessage(message("same", "changed", first.contextId), principal),
    ).rejects.toMatchObject({ code: "message_idempotency_conflict" });
  });

  it("serves authenticated HTTP+JSON discovery, send and task retrieval", async () => {
    const { host } = fixture();
    const unauthorized = await host.handle(
      new Request("http://127.0.0.1:43210/.well-known/agent-card.json"),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const card = await host.handle(
      new Request("http://127.0.0.1:43210/.well-known/agent-card.json", {
        headers: { authorization: "Bearer good" },
      }),
    );
    expect(card.status).toBe(200);

    const sent = await host.handle(
      new Request("http://127.0.0.1:43210/a2a/message:send", {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/a2a+json" },
        body: JSON.stringify({ message: message("http-1", "over-http") }),
      }),
    );
    const sentResult = parseForeignA2ASendResult(await sent.json());
    expect(sentResult.type).toBe("task");
    const task = sentResult.type === "task" ? sentResult.task : undefined;
    expect(task?.status.state).toBe("completed");

    const fetched = await host.handle(
      new Request(`http://127.0.0.1:43210/a2a/tasks/${encodeURIComponent(task!.id)}`, {
        headers: { authorization: "Bearer good" },
      }),
    );
    expect(parseForeignA2ATask(await fetched.json())).toEqual(task);
  });

  it("supports the pinned Inspector SDK 0.3 HTTP+JSON and SSE shapes", async () => {
    const { host } = fixture();
    const response = await host.handle(
      new Request("http://127.0.0.1:43210/a2a/v1/message:stream", {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "sdk-03",
            role: "ROLE_USER",
            content: [{ text: "from-inspector" }],
          },
          configuration: {},
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const payload = JSON.parse((await response.text()).match(/data: (.+)/)![1]!);
    expect(payload.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(payload.task.history[0].content).toEqual([{ text: "from-inspector" }]);
    expect(payload.task.history[0].parts).toBeUndefined();
  });

  it("isolates task ownership by authenticated principal", async () => {
    const { host } = fixture();
    const task = await host.sendMessage(message("private", "secret"), principal);
    await expect(host.getTask(task.id, { principalId: "mallory" })).rejects.toMatchObject({
      code: "task_not_found",
    });
  });

  it("runs discovery and invocation through the real-transport harness", async () => {
    const { host } = fixture();
    const harness = await startAgentHarness({
      agent: host,
      discoveryHeaders: { authorization: "Bearer good" },
    });
    try {
      expect(harness.discoveredCard).toMatchObject({ name: "standard-host" });
      const response = await harness.fetch(
        `${new URL(harness.interfaceUrl).pathname}/message:send`,
        {
          method: "POST",
          headers: { authorization: "Bearer good", "content-type": "application/a2a+json" },
          body: JSON.stringify({ message: message("harness-1", "real-http") }),
        },
      );
      expect(response.status).toBe(200);
      const result = parseForeignA2ASendResult(await response.json());
      expect(result.type === "task" ? result.task.status.state : undefined).toBe("completed");
    } finally {
      await harness.stop();
    }
  });
});
