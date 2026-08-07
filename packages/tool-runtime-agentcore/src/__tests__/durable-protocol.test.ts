import type { AgentCoreRuntimeRelease } from "../placement-types.ts";
import { describe, expect, it } from "vitest";
import { type ReplayOperationEntry } from "@sweatpants/durable-execution";
import { canonicalSnapshot } from "@sweatpants/foundation";

import {
  agentCoreRuntimeReleaseParser,
  agentCoreTaskPlacementParser,
  computeFrontierDigest,
  computeReplayChainSeed,
  createInvocationAgentCorePlacement,
  encodeAgentCoreProgramMessage,
  hostProgramMessageParser,
  linkReplayEntry,
  parseHostProgramMessage,
  parseAgentCoreRuntimeRelease,
  parseAgentCoreTaskPlacement,
  verifyAgentCoreRuntimeRelease,
  verifyReplayEntry,
} from "../index.ts";

const release: AgentCoreRuntimeRelease = {
  releaseId: "release-1",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/release-1",
  region: "us-east-1",
  imageDigest: "sha256:image",
  protocolVersion: 1,
  registryDigest: "registry-digest",
  iamProfile: "pure-evaluator",
  networkProfile: "isolated",
  filesystem: { kind: "managed_session_storage", mountPath: "/mnt/workspace" },
  lifecycle: { idleRuntimeSessionTimeoutSeconds: 180, maxLifetimeSeconds: 28_800 },
};

const attach = {
  sessionId: "session",
  taskId: "task",
  program: { id: "program", version: "1", digest: "a".repeat(64) },
  input: { value: true },
  route: { driverKind: "agentcore" },
  executionEpoch: 3,
} as const;

describe("AgentCore durable placement and protocol", () => {
  it("validates lifecycle bounds and deterministically isolates invocation placements", () => {
    expect(verifyAgentCoreRuntimeRelease(parseAgentCoreRuntimeRelease(release))).toEqual(release);
    expect(agentCoreRuntimeReleaseParser.parse(release)).toEqual({ ok: true, value: release });
    const first = createInvocationAgentCorePlacement({
      journalId: "j",
      rootTaskId: "one",
      program: attach.program,
      release,
      now: () => new Date(0),
    });
    const again = createInvocationAgentCorePlacement({
      journalId: "j",
      rootTaskId: "one",
      program: attach.program,
      release,
      now: () => new Date(0),
    });
    const second = createInvocationAgentCorePlacement({
      journalId: "j",
      rootTaskId: "two",
      program: attach.program,
      release,
      now: () => new Date(0),
    });
    expect(first.runtimeSessionId).toBe(again.runtimeSessionId);
    expect(first.runtimeSessionId).not.toBe(second.runtimeSessionId);
    expect(() =>
      verifyAgentCoreRuntimeRelease(
        parseAgentCoreRuntimeRelease({
          ...release,
          lifecycle: { ...release.lifecycle, idleRuntimeSessionTimeoutSeconds: 301 },
        }),
      ),
    ).toThrow(/idle timeout/);
  });

  it("rejects malformed provider release and placement values before nested access", () => {
    expect(() => parseAgentCoreRuntimeRelease(null)).toThrow(/release metadata/);
    expect(() => parseAgentCoreRuntimeRelease({ ...release, filesystem: null })).toThrow(
      /release metadata/,
    );
    expect(() => parseAgentCoreTaskPlacement({ release })).toThrow(/placement/);
    expect(agentCoreTaskPlacementParser.parse({ release }).ok).toBe(false);
  });

  it("round-trips closed canonical frames and rejects identity/control extensions", () => {
    const message = {
      protocolVersion: 1,
      type: "restore_begin",
      releaseId: release.releaseId,
      taskId: attach.taskId,
      activationEpoch: attach.executionEpoch,
      payload: {
        attach: { ...attach, affinity: { kind: "invocation" as const, key: attach.taskId } },
        programInputDigest: canonicalSnapshot(attach.input).sha,
        replayedThroughActionIndex: 0,
        replayChainSeed: "b".repeat(64),
      },
    } as const;
    const encoded = encodeAgentCoreProgramMessage(message);
    expect(parseHostProgramMessage(encoded)).toEqual(message);
    expect(hostProgramMessageParser.parse(message)).toEqual({ ok: true, value: message });
    expect(hostProgramMessageParser.parse({ ...message, protocolVersion: 2 }).ok).toBe(false);
    expect(() =>
      parseHostProgramMessage(JSON.stringify({ ...message, secretControl: true })),
    ).toThrow(/closed/);
    expect(() =>
      parseHostProgramMessage(JSON.stringify({ ...message, protocolVersion: 2 })),
    ).toThrow(/version/);
  });

  it("integrity-links replay entries and independently hashes the live frontier", () => {
    const nonce = "RAW_RESTORE_NONCE_CANARY";
    const seed = computeReplayChainSeed({
      releaseId: release.releaseId,
      sessionId: attach.sessionId,
      taskId: attach.taskId,
      program: attach.program,
      activationEpoch: attach.executionEpoch,
      journalHeadDigest: "c".repeat(64),
      restoreNonce: nonce,
    });
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(seed).not.toContain(nonce);
    const entry = linkReplayEntry(seed, seed, {
      type: "operation",
      actionIndex: 0,
      descriptorKind: "elicit",
      descriptorDigest: "d".repeat(64),
      outcome: { status: "ok", value: true },
      receipt: {
        sessionId: "session",
        taskId: "task",
        pullId: "pull",
        resolutionOffset: "2",
        outcomeDigest: "e".repeat(64),
        status: "accepted",
      },
    }) as ReplayOperationEntry;
    expect(verifyReplayEntry(seed, seed, entry)).toBe(true);
    expect(verifyReplayEntry(seed, seed, { ...entry, actionIndex: 1 })).toBe(false);
    expect(
      computeFrontierDigest({
        releaseId: release.releaseId,
        taskId: attach.taskId,
        activationEpoch: attach.executionEpoch,
        replayedThroughActionIndex: 0,
        replayChainDigest: entry.entryDigest,
        step: { type: "completed", actionIndex: 1, value: "ok" },
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
