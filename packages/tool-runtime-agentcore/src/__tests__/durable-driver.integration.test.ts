import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  canonicalSnapshot,
  createLocalProgramDriver,
  type DurableToolRegistry,
  type ProgramAttachment,
  type ProgramShutdownReason,
} from "@sweatpants/session-contract";
import {
  normalizeSemanticJournal,
  runDurableDriverCancellationFixture,
  runDurableDriverRecoveryFixture,
} from "@sweatpants/session-contract/testing";

import {
  computeFrontierDigest,
  createAgentCoreDurableProgramDriver,
  type AgentCoreDurableProgramTransport,
} from "../index.ts";

function createReplacingAgentCoreTransport(registry: DurableToolRegistry): {
  transport: AgentCoreDurableProgramTransport;
  containerGenerations: number[];
  shutdownReasons: ProgramShutdownReason[];
  replayEntryCounts: number[];
} {
  const evaluator = createLocalProgramDriver(registry);
  const containerGenerations: number[] = [];
  const shutdownReasons: ProgramShutdownReason[] = [];
  const replayEntryCounts: number[] = [];
  let generation = 0;

  const transport: AgentCoreDurableProgramTransport = {
    *restoreContext(request) {
      const route = request.route as Record<string, unknown>;
      const release = route["release"] as { releaseId: string };
      return {
        replayDomain: "sweatpants.agentcore.replay.v1",
        frontierDomain: "sweatpants.agentcore.frontier.v1",
        releaseId: release.releaseId,
        sandboxSessionId: `sandbox-${request.taskId}`,
      };
    },
    *attach(request) {
      generation += 1;
      containerGenerations.push(generation);
      const local = yield* evaluator.attach(request);
      return {
        ...local,
        driverKind: "agentcore",
        route: {
          driverKind: "agentcore",
          containerGeneration: generation,
          remoteInvocationId: `agentcore-transport-${generation}`,
        },
      } satisfies ProgramAttachment;
    },
    *restore(request) {
      generation += 1;
      containerGenerations.push(generation);
      const local = yield* evaluator.attach(request.attach);
      const attachment = { ...local, driverKind: "agentcore" } satisfies ProgramAttachment;
      let step = yield* evaluator.step(attachment, {
        type: "start",
        input: request.attach.input,
      });
      const entries = [...(request.replay[Symbol.iterator]?.() ?? [])];
      replayEntryCounts.push(entries.length);
      for (const entry of entries) {
        expect(step.actionIndex).toBe(entry.actionIndex);
        expect(step.type).toBe(entry.type);
        if (step.type !== "operation" && step.type !== "emission") {
          throw new Error("fixture replay returned before history ended");
        }
        expect(canonicalSnapshot(step.descriptor).sha).toBe(entry.descriptorDigest);
        step =
          entry.type === "operation"
            ? yield* evaluator.step(attachment, {
                type: "resume",
                actionIndex: entry.actionIndex,
                outcome: entry.outcome,
                receipt: entry.receipt,
                replayed: true,
              })
            : yield* evaluator.step(attachment, {
                type: "ack_emission",
                actionIndex: entry.actionIndex,
                offset: entry.offset,
              });
      }
      const route = request.attach.route as Record<string, unknown>;
      const release = route["release"] as { releaseId: string };
      return {
        attachment,
        frontier: step,
        replayedThroughActionIndex: request.replayedThroughActionIndex,
        replayChainDigest: request.replayChainDigest,
        frontierDigest: computeFrontierDigest({
          releaseId: release.releaseId,
          taskId: request.attach.taskId,
          activationEpoch: request.attach.executionEpoch,
          replayedThroughActionIndex: request.replayedThroughActionIndex,
          replayChainDigest: request.replayChainDigest,
          step,
        }),
        computeGeneration: `generation-${generation}`,
      };
    },
    *step(attachment, command) {
      return yield* evaluator.step(attachment, command);
    },
    *shutdown(attachment, reason) {
      shutdownReasons.push(reason);
      yield* evaluator.shutdown(attachment, reason);
    },
  };

  return { transport, containerGenerations, shutdownReasons, replayEntryCounts };
}

const agentRoute = {
  driverKind: "agentcore",
  journalId: "driver-integration:agentcore",
  release: {
    releaseId: "integration-release",
    runtimeArn: "private-runtime",
    region: "us-east-1",
    imageDigest: "image",
    protocolVersion: 1,
    registryDigest: "registry",
    iamProfile: "pure",
    networkProfile: "isolated",
    filesystem: { kind: "managed_session_storage", mountPath: "/mnt/workspace" },
    lifecycle: { idleRuntimeSessionTimeoutSeconds: 120, maxLifetimeSeconds: 28_800 },
  },
} as const;

describe("AgentCore crank-native ProgramDriver integration", () => {
  it("resolves exact generated manifests from Host-side readiness evidence", async () => {
    let manifestCheck: Promise<void> | undefined;
    await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "agentcore",
        route: agentRoute,
        useActivationLease: true,
        createDriver(registry) {
          const transport = createReplacingAgentCoreTransport(registry).transport;
          const manifests = new Map(
            [...registry.values()].map((tool) => [
              `${tool.manifest.programId}@${tool.manifest.version}#${tool.manifest.digest}`,
              tool.manifest,
            ]),
          );
          const driver = createAgentCoreDurableProgramDriver(transport, { manifests });
          const first = registry.values().next().value;
          if (!first || !driver.manifest) throw new Error("fixture manifest is unavailable");
          manifestCheck = run(() =>
            driver.manifest!({
              id: first.manifest.programId,
              version: first.manifest.version,
              digest: first.manifest.digest,
            }),
          ).then((manifest) => {
            expect(manifest).toEqual(first.manifest);
          });
          return driver;
        },
      }),
    );
    await manifestCheck;
  });

  it("replaces the remote container after park and reconstructs execution from the crank journal", async () => {
    let transportEvidence: ReturnType<typeof createReplacingAgentCoreTransport> | undefined;

    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "agentcore",
        route: agentRoute,
        useActivationLease: true,
        createDriver(registry) {
          transportEvidence = createReplacingAgentCoreTransport(registry);
          return createAgentCoreDurableProgramDriver(transportEvidence.transport);
        },
      }),
    );

    expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
    expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.shutdownCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
    expect(transportEvidence?.containerGenerations).toEqual([1, 2]);
    expect(transportEvidence?.shutdownReasons).toEqual(["parked", "completed"]);
    expect(transportEvidence?.replayEntryCounts).toEqual([0, 3]);
    const semanticJson = JSON.stringify(evidence.semanticJournal);
    expect(semanticJson).not.toContain("containerGeneration");
    expect(semanticJson).not.toContain("remoteInvocationId");
    expect(semanticJson).not.toContain("attachment");
    expect(evidence.normalizedJournal).toEqual([
      "TaskOpened",
      "PullRequested",
      "AttemptStarted",
      "PullResolved",
      "DurableEmission",
      "PullRequested",
      "PullResolved",
      "TaskClosed",
    ]);
  });

  it("matches the local driver's normalized semantic journal", async () => {
    const local = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "program",
        sessionId: "parity-session",
        createDriver: createLocalProgramDriver,
      }),
    );
    const agentcore = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "agentcore",
        sessionId: "parity-session",
        route: agentRoute,
        useActivationLease: true,
        createDriver(registry) {
          return createAgentCoreDurableProgramDriver(
            createReplacingAgentCoreTransport(registry).transport,
          );
        },
      }),
    );
    expect(normalizeSemanticJournal(agentcore.semanticJournal)).toEqual(
      normalizeSemanticJournal(local.semanticJournal),
    );
  });

  it("matches local cancellation-unwind semantics", async () => {
    const local = await run(() =>
      runDurableDriverCancellationFixture({
        driverKind: "program",
        sessionId: "cancellation-parity-session",
        createDriver: createLocalProgramDriver,
      }),
    );
    const agentcore = await run(() =>
      runDurableDriverCancellationFixture({
        driverKind: "agentcore",
        sessionId: "cancellation-parity-session",
        createDriver(registry) {
          return createAgentCoreDurableProgramDriver(
            createReplacingAgentCoreTransport(registry).transport,
          );
        },
      }),
    );
    const localPayloads = normalizeSemanticJournal(local.semanticJournal).map(
      (record) => (record as { payload: unknown }).payload,
    );
    const agentPayloads = normalizeSemanticJournal(agentcore.semanticJournal).map(
      (record) => (record as { payload: unknown }).payload,
    );
    expect(agentPayloads).toEqual(localPayloads);
  });
});
