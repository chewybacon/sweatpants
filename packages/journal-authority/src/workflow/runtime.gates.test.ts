import { describe, expect, it } from "vitest";
import * as Runtime from "./runtime.ts";

const authorizeBase = {
  actionIndex: 0,
  pullId: "pull-kind-gate",
  attemptId: "attempt-kind-gate",
} as const;

const sequentialDescriptors = [
  { kind: "record", key: "kind-gate", retrySafety: { mode: "repeatable" } },
  {
    kind: "effect",
    name: "sample",
    version: "1.0.0",
    input: { prompt: "hi" },
    resolver: { audience: "host" },
  },
  {
    kind: "elicit",
    key: "confirm",
    message: "Proceed?",
    response: {
      identity: "schema:confirm",
      role: "elicitation_response",
      version: "1.0.0",
      vendor: "sweatpants",
      inputProjection: true,
      outputProjection: true,
      fidelity: { input: "lossless", output: "lossless" },
      digest: "deadbeef",
    },
  },
  { kind: "wait", key: "cool-off", durationMs: 5_000 },
  {
    kind: "invoke",
    child: { id: "child", version: "1.0.0", digest: "cafe", input: {} },
  },
] as const;

const combinatorDescriptors = [
  { kind: "all", children: [] },
  { kind: "race", children: [] },
  { kind: "spawn", child: { id: "c", version: "1", digest: "d", input: null } },
  { kind: "join", handle: { __durableTask: "t-1", owner: "parent" } },
] as const;

describe("boundary kind gating", () => {
  it("accepts every sequential pull kind at the command boundary", () => {
    for (const descriptor of sequentialDescriptors) {
      const parsed = Runtime.programCommandParser.parse({
        type: "authorize-record",
        ...authorizeBase,
        descriptor,
      });
      expect(parsed.ok, `kind ${descriptor.kind}`).toBe(true);
    }
  });

  it("rejects parallel combinator descriptors before any reservation or execution", () => {
    for (const descriptor of combinatorDescriptors) {
      const parsed = Runtime.programCommandParser.parse({
        type: "authorize-record",
        ...authorizeBase,
        descriptor: descriptor as unknown as Record<string, unknown>,
      });
      expect(parsed.ok, `kind ${descriptor.kind}`).toBe(false);
    }
  });
});

describe("runtime promotion gates", () => {
  it("exports no quarantine-era names", () => {
    const offenders = Object.keys(Runtime).filter((name) => /Proof|Testing/iu.test(name));
    expect(offenders).toEqual([]);
  });

  it("keeps the promoted value surface present", () => {
    const names = Object.keys(Runtime);
    for (const required of [
      "record",
      "ephemeral",
      "openProgramAttachment",
      "programCommandParser",
      "programShutdownReasonParser",
      "recordWorkflowOptionsParser",
      "ProgramEffectRuntimeContext",
      "RecordAttemptPort",
    ] as const) {
      expect(names).toContain(required);
    }
  });
});
