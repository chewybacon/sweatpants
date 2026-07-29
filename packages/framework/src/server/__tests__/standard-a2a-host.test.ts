import { call, run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { advertiseCapability, defineAgent } from "@sweatpants/core";
import { createCapabilityKeyring } from "@sweatpants/session-contract";
import { createPinnedDurableProgram } from "@sweatpants/durable-execution";
import { sha256, type Json } from "@sweatpants/foundation";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/foundation/schema-descriptor";
import {
  createInMemoryImmutableContentStore,
  parseForeignA2ASendResult,
  parseForeignA2ATask,
  type ImmutableContentStore,
} from "@sweatpants/a2a";
import {
  CHAT_CONTRACT_SCHEMA_ENTRIES,
  CHAT_TURN_RESULT_FORMAT,
  createChatModelEffectRegistration,
  defineChatProgram,
  latestContextWindow,
  normalizeChatTurnResult,
  type ChatModelSampleInputV2,
  type ChatModelSampleOutputV2,
  type ChatProgramDefinition,
} from "@sweatpants/chat-core";
import { startAgentHarness } from "../testing.ts";
import {
  createInMemoryProgramDriverJournalStore,
  createInMemoryStandardA2ATaskDirectory,
  createStandardA2AHost,
  programDriverSchemaRegistry,
  StandardA2ATraceContext,
  serveAgent,
  standardA2A,
  type BoundStandardA2AHost,
  type CreateStandardA2AHostOptions,
} from "../index.ts";

function fixture(
  hostOptions: CreateStandardA2AHostOptions = {},
  modelOutput?: (sample: number, request: ChatModelSampleInputV2) => ChatModelSampleOutputV2,
  historyProjection: "task-only" | "accepted-context" = "accepted-context",
) {
  let samples = 0;
  const traces: string[] = [];
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
    *sample(request, effect): Operation<ChatModelSampleOutputV2> {
      samples += 1;
      const trace = yield* StandardA2ATraceContext.get();
      if (trace) {
        traces.push(trace.traceparent);
      }
      if (modelOutput) {
        return modelOutput(samples, request);
      }
      const latest = request.messages.at(-1)!;
      if (String(latest.parts[0]?.value).includes("WAIT_CANCEL")) {
        yield* call(
          () =>
            new Promise<never>((_resolve, reject) => {
              const cancel = () => reject(new Error("cancelled fixture model"));
              if (effect.cancellation.aborted) {
                cancel();
              } else {
                effect.cancellation.addEventListener("abort", cancel, { once: true });
              }
            }),
        );
      }
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
      historyProjection,
      host: createStandardA2AHost({
        ...hostOptions,
        *authenticate(request) {
          return request.headers.get("authorization") === "Bearer good"
            ? { principalId: "alice", tenantId: "tenant-a" }
            : undefined;
        },
      }),
    }),
  );
  return { host: served.host as BoundStandardA2AHost, samples: () => samples, traces };
}

function interruptionFixture() {
  const manifest = {
    programId: "standard-host.interruption",
    version: "1",
    digest: sha256("standard-host.interruption.v1"),
    inputSchema: CHAT_CONTRACT_SCHEMA_ENTRIES[0]!.descriptor,
    outputSchema: CHAT_CONTRACT_SCHEMA_ENTRIES[1]!.descriptor,
    elicits: { answer: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
    effects: {},
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" as const },
  };
  const durable = createPinnedDurableProgram(manifest, function* (_input, context) {
    const answer = yield* context.elicit<Json>(
      "answer",
      "Provide the continuation answer",
      ANY_JSON_SCHEMA_DESCRIPTOR,
    );
    return normalizeChatTurnResult({
      format: CHAT_TURN_RESULT_FORMAT,
      message: {
        id: "continued-answer",
        role: "assistant",
        parts: [{ value: answer, provenance: { classifications: [], sourceDigests: [] } }],
      },
      artifacts: [],
    }) as unknown as Json;
  });
  const conversation = Object.freeze({
    ...durable,
    kind: "sweatpants.chat-program.v1" as const,
    schemaCatalog: CHAT_CONTRACT_SCHEMA_ENTRIES,
    childPrograms: Object.freeze({}),
    contextPolicy: latestContextWindow(),
  }) as unknown as ChatProgramDefinition;
  const definition = defineAgent({
    identity: { name: "interrupt-agent", version: "1" },
    description: "Input-required fixture",
    conversation,
    programs: { conversation },
  });
  const keyring = createCapabilityKeyring("interrupt-host", [
    { keyId: "test", secret: "interrupt-host-secret-at-least-32-bytes" },
  ]);
  const journalStore = createInMemoryProgramDriverJournalStore({
    keyring,
    schemaRegistry: programDriverSchemaRegistry(CHAT_CONTRACT_SCHEMA_ENTRIES),
  });
  const taskDirectory = createInMemoryStandardA2ATaskDirectory();
  const bind = () =>
    serveAgent(
      definition,
      standardA2A({
        deployment: {
          interfaceUrl: "http://127.0.0.1:43211/a2a",
          insecureLoopbackDevelopment: true,
        },
        handlers: [],
        capabilityBindings: {},
        host: createStandardA2AHost({
          journalStore,
          taskDirectory,
          allowAnonymousDevelopment: true,
          generateContextId: () => "ctx_interrupt",
          generateTaskNonce: () => "interruptnonce",
        }),
      }),
    ).host as BoundStandardA2AHost;
  return { bind };
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

function execute<T>(operation: Operation<T>): Promise<T> {
  return run(function* () {
    return yield* operation;
  });
}

describe("journal-backed standard A2A host", () => {
  it("creates immutable per-turn tasks, preserves context and explicit lineage", async () => {
    const { host, samples } = fixture();
    const first = await execute(host.sendMessage(message("m-1", "first"), principal));
    expect(first.status.state).toBe("completed");
    expect(first.history).toHaveLength(2);

    const second = await execute(
      host.sendMessage(message("m-2", "second", first.contextId, [first.id, first.id]), principal),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(second.metadata).toMatchObject({ referenceTaskIds: [first.id] });
    expect(second.history?.map((entry) => entry.parts[0]?.text)).toEqual([
      "first",
      "answer:first",
      "second",
      "answer:second",
    ]);
    expect((await execute(host.getTask(first.id, principal))).status.state).toBe("completed");
    expect(samples()).toBe(2);

    const evidence = await execute(host.evidence(first.contextId!, principal));
    expect(evidence.acceptedMessages).toBe(2);
    expect(evidence.tasks.map((task) => task.referenceTaskIds)).toEqual([[], [first.id]]);
    expect(evidence.journal.filter((item) => item.type === "TaskClosed")).toHaveLength(2);
  });

  it("supports task-only public history without changing conversation memory", async () => {
    const { host } = fixture({}, undefined, "task-only");
    const first = await execute(host.sendMessage(message("history-1", "first"), principal));
    const second = await execute(
      host.sendMessage(message("history-2", "second", first.contextId), principal),
    );
    expect(second.history?.map((entry) => entry.parts[0]?.text)).toEqual([
      "second",
      "answer:second",
    ]);
  });

  it("propagates validated trace context to local effects without changing identity", async () => {
    const { host, traces } = fixture();
    const tracedPrincipal = {
      ...principal,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const task = await execute(host.sendMessage(message("traced", "hello"), tracedPrincipal));
    expect(task.status.state).toBe("completed");
    expect(traces).toEqual([tracedPrincipal.traceparent]);
    const retry = await execute(
      host.sendMessage(message("traced", "hello", task.contextId), {
        ...tracedPrincipal,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      }),
    );
    expect(retry.id).toBe(task.id);
  });

  it("keeps task IDs opaque when client context IDs contain dots", async () => {
    const { host } = fixture({ allowClientContextIds: true });
    const task = await execute(
      host.sendMessage(message("dot-context", "hello", "customer.context.v1"), principal),
    );
    expect(task.contextId).toBe("customer.context.v1");
    expect(task.id).toMatch(/^task_[a-f0-9]{32}$/);
    expect(task.id).not.toContain(task.contextId);
    expect((await execute(host.getTask(task.id, principal))).contextId).toBe("customer.context.v1");
  });

  it("reconciles identical message retries and rejects conflicting reuse", async () => {
    const { host, samples } = fixture();
    const first = await execute(host.sendMessage(message("same", "one"), principal));
    const retry = await execute(
      host.sendMessage(message("same", "one", first.contextId), principal),
    );
    expect(retry.id).toBe(first.id);
    expect(samples()).toBe(1);
    await expect(
      execute(host.sendMessage(message("same", "changed", first.contextId), principal)),
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
    const payloads = [...(await response.text()).matchAll(/data: (.+)/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(payloads[0].task.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(payloads[1].statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
    expect(payloads[1].statusUpdate.final).toBe(true);
    expect(payloads[0].task.history[0].content).toEqual([{ text: "from-inspector" }]);
    expect(payloads[0].task.history[0].parts).toBeUndefined();
  });

  it("reconciles input-required continuation idempotency after host replacement", async () => {
    const interruption = interruptionFixture();
    const interrupted = await execute(
      interruption.bind().sendMessage(message("interrupt-root", "begin"), principal),
    );
    expect(interrupted.status.state).toBe("input_required");
    const continuation = {
      ...message("continuation-1", "accepted answer", interrupted.contextId),
      taskId: interrupted.id,
    };
    const completed = await execute(interruption.bind().sendMessage(continuation, principal));
    expect(completed.id).toBe(interrupted.id);
    expect(completed.status.state).toBe("completed");
    expect(completed.history?.map((entry) => entry.parts[0]?.text ?? entry.parts[0]?.data)).toEqual(
      [
        "begin",
        "Provide the continuation answer",
        "accepted answer",
        { action: "accept", content: "accepted answer" },
      ],
    );
    const retry = await execute(interruption.bind().sendMessage(continuation, principal));
    expect(retry).toEqual(completed);
    await expect(
      execute(
        interruption
          .bind()
          .sendMessage({ ...continuation, parts: [{ text: "conflicting answer" }] }, principal),
      ),
    ).rejects.toMatchObject({ code: "message_idempotency_conflict" });
  });

  it("records and completes exact-task cancellation while a model effect is live", async () => {
    const { host } = fixture({
      generateContextId: () => "ctx_cancel",
      generateTaskNonce: () => "cancelnonce",
    });
    const taskId = "task_cancelnonce";
    const sending = execute(host.sendMessage(message("cancel-message", "WAIT_CANCEL"), principal));
    let working;
    for (let attempt = 0; attempt < 50 && !working; attempt += 1) {
      try {
        working = await execute(host.getTask(taskId, principal));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(working?.status.state).toBe("working");
    const canceled = await execute(host.cancelTask(taskId, principal));
    expect(canceled.status.state).toBe("canceled");
    expect((await sending).status.state).toBe("canceled");
    const evidence = await execute(host.evidence("ctx_cancel", principal));
    expect(
      evidence.journal.filter((record) => record.type === "CancellationRequested"),
    ).toHaveLength(1);
    expect(evidence.tasks).toEqual([expect.objectContaining({ taskId, state: "canceled" })]);
  });

  it("custodies large artifacts before projecting digest-qualified content URLs", async () => {
    const backing = createInMemoryImmutableContentStore();
    let unavailable = false;
    const contentStore: ImmutableContentStore = {
      put: (input) => backing.put(input),
      get: (digest, now) =>
        unavailable
          ? Promise.resolve({ status: "content_unavailable" as const, digest })
          : backing.get(digest, now),
      deleteOrphans: (input) => backing.deleteOrphans(input),
      check: () => Promise.resolve(),
    };
    const large = "custodied-artifact-".repeat(16);
    const { host } = fixture({ contentStore, externalContentThresholdBytes: 32 }, (sample) => ({
      message: {
        id: `large-answer-${sample}`,
        role: "assistant",
        parts: [{ value: "done", provenance: { classifications: [], sourceDigests: [] } }],
      },
      calls: [],
      artifacts: [
        {
          id: "large-artifact",
          parts: [
            {
              value: large,
              provenance: { classifications: [], sourceDigests: [] },
            },
          ],
        },
      ],
    }));
    const task = await execute(host.sendMessage(message("large", "large"), principal));
    expect(task.status.state).toBe("completed");
    const url = task.artifacts[0]!.parts[0]!.url!;
    expect(url).toMatch(/\/content\/[0-9a-f]{64}$/);
    const content = await host.handle(new Request(url), principal);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(large);
    const evidence = await execute(host.evidence(task.contextId!, principal));
    expect(evidence.contentReferences).toHaveLength(1);

    unavailable = true;
    expect((await execute(host.getTask(task.id, principal))).status.state).toBe("completed");
    const missing = await host.handle(new Request(url), principal);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "content_unavailable" } });
  });

  it("isolates task ownership by authenticated principal", async () => {
    const { host } = fixture();
    const task = await execute(host.sendMessage(message("private", "secret"), principal));
    await expect(execute(host.getTask(task.id, { principalId: "mallory" }))).rejects.toMatchObject({
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
      if (result.type !== "task") {
        throw new Error("expected task");
      }
      await harness.restart();
      const recovered = await harness.fetch(
        `${new URL(harness.interfaceUrl).pathname}/tasks/${encodeURIComponent(result.task.id)}`,
        { headers: { authorization: "Bearer good" } },
      );
      expect(recovered.status).toBe(200);
      expect(parseForeignA2ATask(await recovered.json()).id).toBe(result.task.id);
    } finally {
      await harness.stop();
    }
  });
});
