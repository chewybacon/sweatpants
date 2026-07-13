import { run } from "effection";
import { describe, expect, it } from "vitest";
import { runDurableDriverRecoveryFixture } from "@sweatpants/session-contract/testing";

import { createLocalDurableProgramDriver } from "../index.ts";

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
});
