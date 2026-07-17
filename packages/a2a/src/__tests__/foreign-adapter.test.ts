import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  canonicalSnapshot,
  type Json,
} from "@sweatpants/session-contract";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  FOREIGN_A2A_ADAPTER_PROGRAM,
  ForeignA2AArtifactStreamAssembler,
  ForeignA2ADurableSession,
  ForeignA2ATransportError,
  InMemoryDurableInvocationService,
  createHttpJsonForeignA2AClient,
  deriveForeignA2AContinuationMessageId,
  deriveForeignA2AIdentity,
  parseForeignA2ASendResult,
  parseForeignA2ATask,
  type ForeignA2AClientPort,
  type ForeignA2AInvocationPin,
  type ForeignA2AMessage,
  type ForeignA2ASendResult,
  type ForeignA2ATask,
} from "../index.ts";

const now = Date.now();
function pin(
  level: ForeignA2AInvocationPin["guarantee"]["level"] = "reconciled",
  ambiguityPolicy: ForeignA2AInvocationPin["ambiguityPolicy"] = "surface",
): ForeignA2AInvocationPin {
  return {
    cardDigest: "a".repeat(64),
    agentName: "foreign-agent",
    skillId: "review",
    interface: {
      url: "https://foreign.example/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    },
    extensionUris: level === "reconciled" ? [DURABLE_INVOCATION_EXTENSION_URI] : [],
    guarantee: {
      level,
      source:
        level === "reconciled"
          ? "durable_invocation_extension"
          : level === "idempotent_messages"
            ? "operator_attestation"
            : "base_task_handle",
      negotiatedAt: new Date(now).toISOString(),
      ...(level === "reconciled" || level === "idempotent_messages"
        ? { messageIdempotencyExpiresAt: new Date(now + 60_000).toISOString() }
        : {}),
      ...(level === "reconciled"
        ? {
            invocationExpiresAt: new Date(now + 60_000).toISOString(),
            extension: {
              protocolVersion: 1,
              resolveEndpoint: "https://foreign.example/invocations:resolve",
              abortEndpoint: "https://foreign.example/invocations:abort",
              messageIdempotency: true,
              retention: {
                invocationBindingSeconds: 60,
                abortTombstoneSeconds: 60,
                messageIdempotencySeconds: 60,
                taskSeconds: 3600,
                terminalResultSeconds: 3600,
                clockSkewSeconds: 5,
              },
            },
          }
        : {}),
    },
    ambiguityPolicy,
    invocationId: "inv_test",
    initialMessageId: "msg_initial",
    requestExpiresAt: new Date(now + 60_000).toISOString(),
    principalId: "caller-1",
    tenantId: "tenant-1",
  };
}
function message(messageId = "msg_initial", taskId?: string): ForeignA2AMessage {
  return {
    messageId,
    role: "user",
    parts: [{ text: "hello" }],
    ...(taskId ? { taskId } : {}),
  };
}
function task(
  state: string,
  options: { statusMessage?: Json; artifacts?: Json[] } = {},
): ForeignA2ATask {
  return parseForeignA2ATask({
    id: "task-1",
    contextId: "context-1",
    status: {
      state: `TASK_STATE_${state.toUpperCase()}`,
      ...(options.statusMessage ? { message: options.statusMessage } : {}),
    },
    artifacts: options.artifacts ?? [],
  });
}

describe("foreign A2A protocol and state machine", () => {
  it("normalizes the closed A2A state algebra and direct messages", () => {
    for (const state of [
      "submitted",
      "working",
      "input_required",
      "auth_required",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ]) {
      const statusMessage = state.endsWith("required")
        ? {
            messageId: `remote-${state}`,
            role: "ROLE_AGENT",
            parts: [{ text: "respond" }],
          }
        : undefined;
      expect(task(state, { statusMessage }).status.state).toBe(state);
    }
    expect(
      parseForeignA2ASendResult({
        message: { messageId: "direct-1", role: "ROLE_AGENT", parts: [{ text: "done" }] },
      }),
    ).toMatchObject({ type: "message", message: { role: "agent" } });
    expect(() =>
      parseForeignA2ATask({ id: "x", status: { state: "TASK_STATE_UNKNOWN" } }),
    ).toThrowError(expect.objectContaining({ code: "a2a_protocol_error" }));
  });

  it("assembles bounded artifact chunks and reconciles from the latest task snapshot", () => {
    const assembler = new ForeignA2AArtifactStreamAssembler(3);
    assembler.apply({
      updateId: "update-1",
      taskId: "task-1",
      artifact: { artifactId: "artifact-1", parts: [{ text: "a" }] },
      append: false,
      lastChunk: false,
    });
    assembler.apply({
      updateId: "update-2",
      taskId: "task-1",
      artifact: { artifactId: "artifact-1", parts: [{ text: "b" }] },
      append: true,
      lastChunk: true,
    });
    expect(assembler.artifact("task-1", "artifact-1")?.parts).toEqual([
      { text: "a" },
      { text: "b" },
    ]);
    expect(() =>
      assembler.apply({
        updateId: "update-2",
        taskId: "task-1",
        artifact: { artifactId: "artifact-1", parts: [{ text: "changed" }] },
        append: true,
        lastChunk: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "a2a_observation_conflict" }));
    assembler.reconcile(
      task("completed", {
        artifacts: [{ artifactId: "artifact-1", parts: [{ text: "canonical" }] }],
      }),
    );
    expect(assembler.artifact("task-1", "artifact-1")?.parts).toEqual([{ text: "canonical" }]);
  });

  it("derives opaque stable identities without exposing durable structure", () => {
    const key = "a-deployment-specific-derivation-key-at-least-32-bytes";
    const local = { sessionId: "private-session", taskId: "turn-0/root", pullId: "pull-1" };
    const invocation = deriveForeignA2AIdentity(key, "invocation", local);
    expect(invocation).toBe(deriveForeignA2AIdentity(key, "invocation", local));
    expect(invocation).not.toContain("private-session");
    expect(deriveForeignA2AContinuationMessageId(key, local, 1)).not.toBe(
      deriveForeignA2AContinuationMessageId(key, local, 2),
    );
  });

  it("reconciles a lost initial response without creating another task", async () => {
    let sends = 0;
    let resolves = 0;
    const bound: ForeignA2ASendResult = { type: "task", task: task("working") };
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        sends += 1;
        throw new ForeignA2ATransportError("lost", "response lost", true);
      },
      *resolveInvocation() {
        resolves += 1;
        return { status: "bound", result: bound };
      },
      *sendContinuation() {
        throw new Error("unused");
      },
      *getTask() {
        return task("completed");
      },
      *cancelTask() {
        return task("canceled");
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const transition = await run(() =>
      session.start({ pin: pin(), message: message(), maxDispatchAttempts: 3 }),
    );
    expect(sends).toBe(1);
    expect(resolves).toBe(1);
    expect(transition.state.binding).toEqual({ taskId: "task-1", contextId: "context-1" });
    expect(transition.event.type).toBe("progress");
  });

  it("surfaces unreconcilable ambiguity without automatic redispatch", async () => {
    let sends = 0;
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        sends += 1;
        throw new ForeignA2ATransportError("lost", "response lost", true);
      },
      *sendContinuation() {
        throw new Error("unused");
      },
      *getTask() {
        throw new Error("unused");
      },
      *cancelTask() {
        throw new Error("unused");
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const transition = await run(() =>
      session.start({ pin: pin("task_handle_only"), message: message(), maxDispatchAttempts: 3 }),
    );
    expect(sends).toBe(1);
    expect(transition.event).toMatchObject({
      type: "indeterminate",
      result: { phase: "initial_dispatch", remoteTaskMayExist: true },
    });
  });

  it("returns typed interruptions and rejects conflicting repeated request identities", async () => {
    let observation = task("input_required", {
      statusMessage: {
        messageId: "remote-question",
        role: "ROLE_AGENT",
        parts: [{ text: "Need input" }],
      },
    });
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        return { type: "task", task: observation };
      },
      *sendContinuation() {
        return { type: "task", task: task("completed") };
      },
      *getTask() {
        return observation;
      },
      *cancelTask() {
        return task("canceled");
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const first = await run(() => session.start({ pin: pin(), message: message() }));
    expect(first.event).toMatchObject({
      type: "interruption",
      interruption: { type: "input_required", taskId: "task-1" },
    });
    observation = task("input_required", {
      statusMessage: {
        messageId: "remote-question",
        role: "ROLE_AGENT",
        parts: [{ text: "Changed under same ID" }],
      },
    });
    await expect(run(() => session.observe(first.state))).rejects.toMatchObject({
      code: "a2a_observation_conflict",
    });
  });

  it("falls back from subscription loss to authenticated GetTask without redispatch", async () => {
    let gets = 0;
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        return { type: "task", task: task("working") };
      },
      *sendContinuation() {
        throw new Error("unused");
      },
      *getTask() {
        gets += 1;
        return task("completed");
      },
      *cancelTask() {
        return task("canceled");
      },
      *subscribeTask() {
        return {
          async *[Symbol.asyncIterator]() {
            throw new Error("stream lost");
          },
        };
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const started = await run(() => session.start({ pin: pin(), message: message() }));
    const observed = await run(() => session.observe(started.state));
    expect(observed.event).toMatchObject({ type: "terminal", result: { status: "completed" } });
    expect(gets).toBe(1);
  });

  it("stops before continuation dispatch when message-idempotency retention expires", async () => {
    let continuations = 0;
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        return {
          type: "task",
          task: task("input_required", {
            statusMessage: {
              messageId: "question-expiry",
              role: "ROLE_AGENT",
              parts: [{ text: "answer" }],
            },
          }),
        };
      },
      *sendContinuation() {
        continuations += 1;
        return { type: "task", task: task("completed") };
      },
      *getTask() {
        return task("working");
      },
      *cancelTask() {
        return task("canceled");
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const started = await run(() => session.start({ pin: pin(), message: message() }));
    const expiredPin = {
      ...started.state.pin,
      guarantee: {
        ...started.state.pin.guarantee,
        messageIdempotencyExpiresAt: new Date(Date.now() - 1).toISOString(),
      },
    };
    await expect(
      run(() =>
        session.respond(
          { ...started.state, pin: expiredPin },
          {
            pin: expiredPin,
            taskId: "task-1",
            contextId: "context-1",
            message: { messageId: "continue-expired", role: "user", parts: [{ text: "answer" }] },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "a2a_guarantee_expired" });
    expect(continuations).toBe(0);
  });

  it("uses AbortInvocation as the future-create cancellation fence", async () => {
    let aborts = 0;
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        throw new Error("unused");
      },
      *sendContinuation() {
        throw new Error("unused");
      },
      *getTask() {
        throw new Error("unused");
      },
      *cancelTask() {
        throw new Error("unused");
      },
      *resolveInvocation() {
        return { status: "not_found" };
      },
      *abortInvocation() {
        aborts += 1;
        return { status: "aborted", expiresAt: new Date(now + 120_000).toISOString() };
      },
    };
    const session = new ForeignA2ADurableSession({ client });
    const state = {
      pin: pin(),
      observationDigests: {},
      initialMessageDigest: canonicalSnapshot(message()).sha,
      continuationIndex: 0,
    };
    expect(await run(() => session.cancel(state))).toMatchObject({
      status: "definitely_not_created",
    });
    expect(aborts).toBe(1);
  });

  it("keeps the dedicated adapter identity separate from the legacy foreign adapter", () => {
    expect(FOREIGN_A2A_ADAPTER_PROGRAM.id).not.toBe(FOREIGN_TOOL_ADAPTER_PROGRAM.id);
    expect(FOREIGN_A2A_ADAPTER_PROGRAM.digest).not.toBe(FOREIGN_TOOL_ADAPTER_PROGRAM.digest);
  });
});

describe("durable-invocation extension reference service", () => {
  it("linearizes create/resolve, deduplicates messages, detects conflict, and fences abort", async () => {
    let clock = now;
    const service = new InMemoryDurableInvocationService({
      now: () => clock,
      retention: {
        invocationBindingSeconds: 60,
        abortTombstoneSeconds: 60,
        messageIdempotencySeconds: 30,
        taskSeconds: 3600,
        terminalResultSeconds: 3600,
        clockSkewSeconds: 5,
      },
    });
    const create = {
      principalId: "caller",
      invocationId: "inv-1",
      messageId: "msg-1",
      messageDigest: "digest-1",
      requestExpiresAt: new Date(now + 10_000).toISOString(),
    };
    let creations = 0;
    const result: ForeignA2ASendResult = { type: "task", task: task("working") };
    expect(
      await Promise.all([
        service.create(create, async () => {
          creations += 1;
          return result;
        }),
        service.create(create, async () => {
          creations += 1;
          return result;
        }),
      ]),
    ).toEqual([result, result]);
    expect(creations).toBe(1);
    expect(await service.resolve(create)).toEqual({ status: "bound", result });
    await expect(
      service.create({ ...create, messageDigest: "different" }, async () => result),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
    });

    const abortRequest = { ...create, invocationId: "inv-abort", messageDigest: "abort-digest" };
    const aborted = await service.abort(abortRequest);
    expect(aborted.status).toBe("aborted");
    await expect(
      service.create({ ...abortRequest, messageId: "late" }, async () => result),
    ).rejects.toMatchObject({
      code: "a2a_invocation_aborted",
    });

    let messages = 0;
    const continuation = {
      ...create,
      messageId: "continue-1",
      messageDigest: "continue-digest",
      taskId: "task-1",
      contextId: "context-1",
    };
    await Promise.all([
      service.processMessage(continuation, async () => {
        messages += 1;
        return result;
      }),
      service.processMessage(continuation, async () => {
        messages += 1;
        return result;
      }),
    ]);
    expect(messages).toBe(1);
    clock += 31_000;
    expect(service.recordCount().messages).toBe(0);
  });
});

describe("HTTP+JSON binding", () => {
  it("sends non-blocking requests with pinned principal, tenant, and extension activation", async () => {
    const requests: Array<{
      body?: Json;
      headers: Readonly<Record<string, string>>;
      principalId: string;
      tenantId?: string;
    }> = [];
    const client = createHttpJsonForeignA2AClient({
      transport: {
        async request(request) {
          requests.push(request);
          return {
            status: 200,
            headers: { "a2a-extensions": DURABLE_INVOCATION_EXTENSION_URI },
            body: { task: wireTask("TASK_STATE_WORKING") },
          };
        },
      },
    });
    await run(() => client.sendInitial({ pin: pin(), message: message() }));
    expect(requests[0]).toMatchObject({
      principalId: "caller-1",
      tenantId: "tenant-1",
      body: { configuration: { returnImmediately: true } },
    });
    expect(requests[0]!.headers["A2A-Extensions"]).toBe(DURABLE_INVOCATION_EXTENSION_URI);
  });
});

function wireTask(state: string): Json {
  return { id: "task-1", contextId: "context-1", status: { state }, artifacts: [] };
}
