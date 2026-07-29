import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  DurableEffectRegistryContext,
  withJournalAuthority,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createInMemoryDurableJournalAuthority,
} from "@sweatpants/session-contract";
import { createDurableToolRegistry, createLocalProgramDriver } from "@sweatpants/durable-execution";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  FOREIGN_A2A_ADAPTER_PROGRAM,
  FOREIGN_A2A_OBSERVE_EFFECT,
  FOREIGN_A2A_SCHEMA_ENTRIES,
  FOREIGN_A2A_START_SURFACE_EFFECT,
  ForeignA2ADurableSession,
  createForeignA2AEffectRegistrations,
  foreignA2ATaskAdapter,
  parseForeignA2ATask,
  type ForeignA2AClientPort,
  type ForeignA2AInvocationPin,
} from "../index.ts";

const pin: ForeignA2AInvocationPin = {
  cardDigest: "a".repeat(64),
  agentName: "opaque-agent",
  skillId: "work",
  interface: {
    url: "https://foreign.example/a2a",
    protocolBinding: "HTTP+JSON",
    protocolVersion: "1.0",
  },
  extensionUris: [],
  guarantee: {
    level: "task_handle_only",
    source: "base_task_handle",
    negotiatedAt: new Date().toISOString(),
  },
  ambiguityPolicy: "surface",
  invocationId: "inv-durable-adapter",
  initialMessageId: "msg-initial",
  requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  principalId: "caller",
};

describe("pinned foreign A2A adapter program", () => {
  it("compiles start and observation through durable effects to one terminal result", async () => {
    let observations = 0;
    const client: ForeignA2AClientPort = {
      *sendInitial() {
        return { type: "task", task: remoteTask("TASK_STATE_WORKING") };
      },
      *sendContinuation() {
        throw new Error("unused");
      },
      *getTask() {
        observations += 1;
        return remoteTask("TASK_STATE_COMPLETED");
      },
      *cancelTask() {
        return remoteTask("TASK_STATE_CANCELED");
      },
    };
    const registrations = createForeignA2AEffectRegistrations({
      session: new ForeignA2ADurableSession({ client }),
      pollIntervalMs: 1,
      *decide() {
        throw new Error("no interruption expected");
      },
    });
    const authority = createInMemoryDurableJournalAuthority({
      journalId: "foreign-a2a-adapter-test",
      journalIncarnation: "test-1",
      keyring: createCapabilityKeyring("foreign-a2a-adapter-test", [
        { keyId: "test-key", secret: "foreign-a2a-adapter-test-secret-32-bytes" },
      ]),
      schemaRegistry: createDurableSchemaRegistry([...FOREIGN_A2A_SCHEMA_ENTRIES]),
    });
    const attach = {
      sessionId: "foreign-a2a-session",
      taskId: "turn-0/root",
      program: FOREIGN_A2A_ADAPTER_PROGRAM,
      input: {
        request: {
          pin,
          message: {
            messageId: pin.initialMessageId,
            role: "user" as const,
            parts: [{ text: "work" }],
          },
        },
      },
      route: { driverKind: "program" },
      executionEpoch: 1,
    };
    const result = await run(function* () {
      yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest: foreignA2ATaskAdapter.manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: "unattached",
        audience: "foreign-a2a-adapter",
      });
      return yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([
          ["program", createLocalProgramDriver(createDurableToolRegistry([foreignA2ATaskAdapter]))],
        ]),
        function* () {
          return yield* withJournalAuthority(authority, function* () {
            return yield* DurableEffectRegistryContext.with(
              createDurableEffectRegistry(registrations),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        },
      );
    });
    expect(result).toMatchObject({
      state: "completed",
      value: { status: "completed", taskId: "task-1" },
    });
    expect(observations).toBe(1);
    const effectNames = authority
      .readJournal(attach.sessionId)
      .flatMap((record) =>
        record.payload.type === "PullRequested" && record.payload.descriptor.kind === "effect"
          ? [record.payload.descriptor.name]
          : [],
      );
    expect(effectNames).toContain(FOREIGN_A2A_START_SURFACE_EFFECT.name);
    expect(effectNames).toContain(FOREIGN_A2A_OBSERVE_EFFECT.name);
  });
});

function remoteTask(state: string) {
  return parseForeignA2ATask({
    id: "task-1",
    contextId: "context-1",
    status: { state },
    artifacts: [
      {
        artifactId: "artifact-1",
        parts: [{ text: state === "TASK_STATE_COMPLETED" ? "done" : "working" }],
      },
    ],
  });
}
