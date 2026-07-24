import { describe, expect, it } from "vitest";

import {
  firstTraceDivergence,
  runProgramDriverConformance,
} from "../program-driver-conformance.ts";
import type { NormalizedProgramTrace } from "../local-program-host.ts";

const trace: NormalizedProgramTrace = {
  version: 1,
  tasks: [
    {
      taskId: "turn-0/root",
      turnId: "turn-0",
      program: { id: "fixture", version: "1", digest: "a".repeat(64) },
      acceptedInput: null,
      operations: [],
      semanticEmissions: [],
      cancellations: [],
      terminal: { status: "ok", value: "done" },
    },
  ],
};

describe("provider-neutral ProgramDriver conformance", () => {
  it("accepts an equivalent normalized trace without provider-specific fields", async () => {
    await expect(
      runProgramDriverConformance({
        name: "program",
        expected: trace,
        async execute() {
          return structuredClone(trace);
        },
      }),
    ).resolves.toEqual({ name: "program", trace });
  });

  it("reports the first exact semantic divergence", async () => {
    const changed = structuredClone(trace);
    changed.tasks[0]!.terminal = { status: "ok", value: "different" };
    expect(firstTraceDivergence(trace, changed)?.path).toBe("$.tasks[0].terminal.value");
    await expect(
      runProgramDriverConformance({
        name: "worker",
        expected: trace,
        async execute() {
          return changed;
        },
      }),
    ).rejects.toThrow("$.tasks[0].terminal.value");
  });
});
