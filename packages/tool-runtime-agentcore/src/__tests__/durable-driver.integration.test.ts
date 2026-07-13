import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  createLocalGeneratorDriver,
  type DurableToolRegistry,
  type ProgramAttachment,
  type ProgramShutdownReason,
} from "@sweatpants/session-contract";
import { runDurableDriverRecoveryFixture } from "@sweatpants/session-contract/testing";

import {
  createAgentCoreDurableProgramDriver,
  type AgentCoreDurableProgramTransport,
} from "../index.ts";

function createReplacingAgentCoreTransport(registry: DurableToolRegistry): {
  transport: AgentCoreDurableProgramTransport;
  containerGenerations: number[];
  shutdownReasons: ProgramShutdownReason[];
} {
  const evaluator = createLocalGeneratorDriver(registry);
  const containerGenerations: number[] = [];
  const shutdownReasons: ProgramShutdownReason[] = [];
  let generation = 0;

  const transport: AgentCoreDurableProgramTransport = {
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
    *step(attachment, command) {
      return yield* evaluator.step(attachment, command);
    },
    *shutdown(attachment, reason) {
      shutdownReasons.push(reason);
      yield* evaluator.shutdown(attachment, reason);
    },
  };

  return { transport, containerGenerations, shutdownReasons };
}

describe("AgentCore crank-native ProgramDriver integration", () => {
  it("replaces the remote container after park and reconstructs execution from the crank journal", async () => {
    let transportEvidence: ReturnType<typeof createReplacingAgentCoreTransport> | undefined;

    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "agentcore",
        route: { driverKind: "agentcore", profile: "integration-fake" },
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
});
