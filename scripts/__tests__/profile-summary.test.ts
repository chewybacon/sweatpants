import { describe, expect, it } from "vitest";
import { summarizeProfile } from "../profiling/summarize-profile.mjs";

describe("Worker profile accounting", () => {
  it("combines the same function under different callers, excludes waiting, and includes GC", () => {
    const frame = { functionName: "hash", url: "worker.js", lineNumber: 5, columnNumber: 0 };
    const result = summarizeProfile({
      startTime: 0,
      endTime: 10_000,
      nodes: [
        { id: 1, callFrame: frame },
        { id: 2, callFrame: { ...frame }, children: [3] },
        { id: 3, callFrame: { ...frame, functionName: "(idle)" } },
        { id: 4, callFrame: { ...frame, functionName: "(garbage collector)" } },
      ],
      samples: [1, 3, 2, 4],
      timeDeltas: [1000, 6000, 2000, 1000],
    });
    expect(result.activeMs).toBe(4);
    expect(result.elapsedMs).toBe(10);
    expect(result.hottestSelfFrames).toEqual([
      { ...frame, selfMs: 3 },
      { ...frame, functionName: "(garbage collector)", selfMs: 1 },
    ]);
  });

  it("orders out-of-order samples without inventing or losing elapsed time", () => {
    const frame = { functionName: "hash", url: "worker.js", lineNumber: 5, columnNumber: 0 };
    const result = summarizeProfile({
      startTime: 0,
      endTime: 200,
      nodes: [{ id: 1, callFrame: frame }],
      samples: [1, 1, 1],
      timeDeltas: [100, -1, 101],
    });
    expect(result.activeMs).toBe(0.2);
    expect(result.hottestSelfFrames[0].selfMs).toBeCloseTo(0.2);
  });

  it("rejects incomplete captures instead of reporting a misleading zero", () => {
    expect(() =>
      summarizeProfile({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 }),
    ).toThrow("missing aligned samples");
    expect(() =>
      summarizeProfile({ nodes: [], samples: [5], timeDeltas: [100], startTime: 0, endTime: 100 }),
    ).toThrow("Invalid CPU sample");
  });
});
