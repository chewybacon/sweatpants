import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  runDurableDriverCancellationFixture,
  runDurableDriverRecoveryFixture,
} from "@sweatpants/session-contract/testing";

import {
  createLocalDurableProgramDriver,
  createLocalWorkerDurableProgramDriver,
} from "../index.ts";

const durableWorkerUrl = new URL(
  "./fixtures/durable-program-worker-bootstrap.mjs",
  import.meta.url,
);

describe("local crank-native ProgramDriver integration", () => {
  it("parks processlessly and completes from a fresh generator using only journal replay", async () => {
    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "generator",
        route: { driverKind: "generator", runtime: "local-package" },
        createDriver: (registry) => createLocalDurableProgramDriver(registry),
      }),
    );

    expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
    expect(evidence.resolutionStatus).toBe("accepted");
    expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
    expect(evidence.invocationId).toBe("turn-0/root");
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.shutdownCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
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

  it("replays cancellation into typed catch/finally cleanup without allowing catch-return success", async () => {
    const evidence = await run(() =>
      runDurableDriverCancellationFixture({
        driverKind: "generator",
        route: { driverKind: "generator", runtime: "local-package" },
        createDriver: (registry) => createLocalDurableProgramDriver(registry),
      }),
    );

    expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
    expect(evidence.secondRun).toEqual({ state: "cancelled" });
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.shutdownCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
    expect(evidence.cleanupExecutions).toBe(1);
    expect(evidence.cancellationCatches).toBe(1);
    expect(evidence.normalizedJournal).toEqual([
      "TaskOpened",
      "PullRequested",
      "AttemptStarted",
      "PullResolved",
      "PullRequested",
      "CancellationRequested",
      "PullResolved",
      "DurableEmission",
      "PullRequested",
      "AttemptStarted",
      "PullResolved",
      "DurableEmission",
      "TaskClosed",
    ]);
    expect(evidence.semanticJournal.at(-1)?.payload).toEqual({
      type: "TaskClosed",
      taskId: evidence.invocationId,
      outcome: { status: "cancelled" },
    });
    expect(JSON.stringify(evidence.semanticJournal)).not.toContain(
      "caught-cancellation-must-not-be-success",
    );
  });

  it("replaces a real worker after park and completes through journal replay", async () => {
    const evidence = await run(() =>
      runDurableDriverRecoveryFixture({
        driverKind: "worker",
        route: { driverKind: "worker", runtime: "local-worker-package" },
        createDriver: () =>
          createLocalWorkerDurableProgramDriver({
            workerUrl: durableWorkerUrl,
            name: "durable-recovery-fixture",
          }),
      }),
    );

    expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
    expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.shutdownCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
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

  it("replays typed cancellation and cleanup in a replacement worker", async () => {
    const evidence = await run(() =>
      runDurableDriverCancellationFixture({
        driverKind: "worker",
        route: { driverKind: "worker", runtime: "local-worker-package" },
        createDriver: () =>
          createLocalWorkerDurableProgramDriver({
            workerUrl: durableWorkerUrl,
            name: "durable-cancellation-fixture",
          }),
      }),
    );

    expect(evidence.secondRun).toEqual({ state: "cancelled" });
    expect(evidence.attachmentWasProcessless).toBe(true);
    expect(evidence.attachmentCount).toBe(2);
    expect(evidence.shutdownCount).toBe(2);
    expect(evidence.effectExecutions).toBe(1);
    expect(evidence.cleanupExecutions).toBe(1);
    expect(evidence.cancellationCatches).toBe(1);
    expect(evidence.semanticJournal.at(-1)?.payload).toMatchObject({
      type: "TaskClosed",
      outcome: { status: "cancelled" },
    });
  });
});
