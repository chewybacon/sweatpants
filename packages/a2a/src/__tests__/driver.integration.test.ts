import { run } from "effection";
import { describe, expect, it } from "vitest";
import { canonicalSnapshot, createDurableToolRegistry } from "@sweatpants/session-contract";
import {
  DURABLE_DRIVER_FIXTURE_TOOLS,
  createInProcessA2AConnector,
  createRegistryManifestProvider,
  runDurableDriverCancellationFixture,
  runDurableDriverRecoveryFixture,
} from "../testing.ts";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  computeA2ACommandId,
  createA2AProgramDriver,
  createA2AProgramExecutor,
  encodeA2AProgramMessage,
  parseServerProgramMessage,
} from "../index.ts";

function createFixtureDriver(registry: ReturnType<typeof createDurableToolRegistry>) {
  const executor = createA2AProgramExecutor({
    executorId: "reference-executor",
    computeGeneration: "generation-1",
    registry,
  });
  return createA2AProgramDriver({
    connector: createInProcessA2AConnector(executor),
    manifest: createRegistryManifestProvider(registry),
  });
}

const route = {
  driverKind: "a2a",
  protocolVersion: 1,
  extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
  executionId: "conformance-execution",
  driverEndpoint: "wss://review.example/programs",
  cardOrigin: "https://review.example",
} as const;

describe("remote A2A ProgramDriver", () => {
  it("passes provider-neutral park/recovery using fresh remote attachments", async () => {
    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "a2a",
        route,
        createDriver: createFixtureDriver,
      }),
    );
    expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
    expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
  });

  it("passes streamed restore with caller-authority replay and frontier verification", async () => {
    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "a2a",
        route: { ...route, executionId: "restore-conformance" },
        createDriver: createFixtureDriver,
        useActivationLease: true,
      }),
    );
    expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
    expect(evidence.effectExecutions).toBe(1);
  });

  it("preserves one-shot cancellation and cleanup through remote replay", async () => {
    const evidence = await run(() =>
      runDurableDriverCancellationFixture({
        driverKind: "a2a",
        route: { ...route, executionId: "cancel-conformance" },
        createDriver: createFixtureDriver,
      }),
    );
    expect(evidence.secondRun).toEqual({ state: "cancelled" });
    expect(evidence.cleanupExecutions).toBe(1);
    expect(evidence.cancellationCatches).toBe(1);
  });

  it("fences stale attachments when a newer execution epoch is accepted", async () => {
    const registry = createDurableToolRegistry(DURABLE_DRIVER_FIXTURE_TOOLS);
    const executor = createA2AProgramExecutor({
      executorId: "epoch-executor",
      computeGeneration: "generation-1",
      registry,
    });
    const program = {
      id: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.programId,
      version: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.version,
      digest: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.digest,
    };
    const result = await run(function* () {
      const first = executor.openConnection({
        principal: { principalId: "caller" },
        activatedExtension: CALLER_AUTHORITATIVE_EXTENSION_URI,
      });
      const second = executor.openConnection({
        principal: { principalId: "caller" },
        activatedExtension: CALLER_AUTHORITATIVE_EXTENSION_URI,
      });
      const attach = (epoch: number) => ({
        protocolVersion: 1 as const,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executionId: "shared-execution",
        program,
        executionEpoch: epoch,
        type: "attach_begin" as const,
        payload: {
          input: "hello",
          inputDigest: canonicalSnapshot("hello").sha,
          affinity: { kind: "invocation", key: "remote-task" },
        },
      });
      const firstReadyRaw = yield* first.handle(encodeA2AProgramMessage(attach(1)));
      const firstReady = parseServerProgramMessage(firstReadyRaw!);
      if (firstReady.type !== "attachment_ready") {
        throw new Error("first attach failed");
      }
      yield* second.handle(encodeA2AProgramMessage(attach(2)));
      const command = { type: "start" as const, input: "hello" };
      const commandId = computeA2ACommandId({
        executionId: "shared-execution",
        executionEpoch: 1,
        attachmentId: firstReady.payload.attachmentId,
        command,
      });
      const staleRaw = yield* first.handle(
        encodeA2AProgramMessage({
          ...attach(1),
          type: "command",
          attachmentId: firstReady.payload.attachmentId,
          commandId,
          payload: { command },
        }),
      );
      return parseServerProgramMessage(staleRaw!);
    });
    expect(result).toMatchObject({ type: "rejected", payload: { code: "stale_activation" } });
    expect(executor.latestEpoch("shared-execution")).toBe(2);
  });

  it("returns identical attachment-scoped responses and rejects conflicting command reuse", async () => {
    const registry = createDurableToolRegistry(DURABLE_DRIVER_FIXTURE_TOOLS);
    const executor = createA2AProgramExecutor({
      executorId: "idempotency-executor",
      computeGeneration: "generation-1",
      registry,
      resourceLimits: { maxCommandsPerAttachment: 1 },
    });
    const program = {
      id: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.programId,
      version: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.version,
      digest: DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.digest,
    };
    const result = await run(function* () {
      const connection = executor.openConnection({
        principal: { principalId: "caller" },
        activatedExtension: CALLER_AUTHORITATIVE_EXTENSION_URI,
      });
      const executionId = "idempotency-execution";
      const attach = {
        protocolVersion: 1 as const,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executionId,
        program,
        executionEpoch: 1,
        type: "attach_begin" as const,
        payload: {
          input: "hello",
          inputDigest: "",
          affinity: { kind: "invocation", key: "remote-task" },
        },
      };
      attach.payload.inputDigest = canonicalSnapshot("hello").sha;
      const readyRaw = yield* connection.handle(encodeA2AProgramMessage(attach));
      const ready = parseServerProgramMessage(readyRaw!);
      if (ready.type !== "attachment_ready") {
        throw new Error("expected attachment");
      }
      const command = { type: "start" as const, input: "hello" };
      const commandId = computeA2ACommandId({
        executionId,
        executionEpoch: 1,
        attachmentId: ready.payload.attachmentId,
        command,
      });
      const frame = {
        protocolVersion: 1 as const,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executionId,
        program,
        executionEpoch: 1,
        type: "command" as const,
        attachmentId: ready.payload.attachmentId,
        commandId,
        payload: { command },
      };
      const first = yield* connection.handle(encodeA2AProgramMessage(frame));
      const duplicate = yield* connection.handle(encodeA2AProgramMessage(frame));
      const conflict = yield* connection.handle(
        encodeA2AProgramMessage({
          ...frame,
          payload: { command: { ...command, input: "changed" } },
        }),
      );
      const nextCommand = {
        type: "authorize" as const,
        actionIndex: 0,
        pullId: "pull-0",
        attemptId: "attempt-0",
      };
      const limited = yield* connection.handle(
        encodeA2AProgramMessage({
          ...frame,
          actionIndex: 0,
          commandId: computeA2ACommandId({
            executionId,
            executionEpoch: 1,
            attachmentId: ready.payload.attachmentId,
            command: nextCommand,
          }),
          payload: { command: nextCommand },
        }),
      );
      return {
        first,
        duplicate,
        conflict: parseServerProgramMessage(conflict!),
        limited: parseServerProgramMessage(limited!),
      };
    });
    expect(result.duplicate).toBe(result.first);
    expect(result.conflict).toMatchObject({
      type: "rejected",
      payload: { code: "idempotency_conflict" },
    });
    expect(result.limited).toMatchObject({
      type: "rejected",
      payload: { code: "program_protocol_error" },
    });
  });
});
