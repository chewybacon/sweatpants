import { CrankError } from "@sweatpants/durable-execution";
import { describe, expect, it } from "vitest";
import { canonicalJson, type ProgramCommand } from "@sweatpants/session-contract";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  computeA2ACommandId,
  encodeA2AProgramMessage,
  parseClientProgramMessage,
  parseExecutorHello,
  projectProgramCommand,
  type ClientProgramMessageV1,
  type ExecutorHelloV1,
} from "../index.ts";

const program = { id: "reviewer", version: "1.0.0", digest: "a".repeat(64) };

describe("caller-authoritative A2A protocol", () => {
  it("requires the exact first-frame extension echo", () => {
    const hello: ExecutorHelloV1 = {
      type: "hello" as const,
      protocolVersion: 1 as const,
      extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
      executorId: "executor-1",
      maxFrameBytes: 2097152 as const,
      capabilities: { streamedRestore: true },
    };
    expect(parseExecutorHello(encodeA2AProgramMessage(hello))).toEqual(hello);
    expect(() =>
      parseExecutorHello(canonicalJson({ ...hello, extensionUri: "https://invalid.example/v1" })),
    ).toThrowError(expect.objectContaining({ code: "extension_echo_mismatch" }));
  });

  it("rejects noncanonical and unknown envelope fields", () => {
    const message: Extract<ClientProgramMessageV1, { type: "attach_begin" }> = {
      protocolVersion: 1 as const,
      extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
      executionId: "execution-1",
      program,
      executionEpoch: 1,
      type: "attach_begin" as const,
      payload: {
        input: "hello",
        inputDigest: "b".repeat(64),
        affinity: { kind: "invocation", key: "remote-task" },
      },
    };
    expect(parseClientProgramMessage(encodeA2AProgramMessage(message))).toEqual(message);
    expect(() => parseClientProgramMessage(JSON.stringify(message))).toThrowError(
      expect.objectContaining({ code: "program_protocol_error" }),
    );
    expect(() =>
      parseClientProgramMessage(canonicalJson({ ...message, journalId: "private" })),
    ).toThrowError(expect.objectContaining({ code: "program_protocol_error" }));
  });

  it("withholds authority resolution capabilities from authorize commands", () => {
    const command: ProgramCommand = {
      type: "authorize",
      actionIndex: 2,
      pullId: "pull-2",
      attemptId: "attempt-2",
      resolutionCapability: "secret-capability",
    };
    const projected = projectProgramCommand(command);
    expect(projected).toEqual({
      type: "authorize",
      actionIndex: 2,
      pullId: "pull-2",
      attemptId: "attempt-2",
    });
    expect(canonicalJson(projected)).not.toContain("secret-capability");
  });

  it("derives stable attachment-scoped command identities", () => {
    const input = {
      executionId: "execution-1",
      executionEpoch: 3,
      attachmentId: "attachment-1",
      command: { type: "start" as const, input: "hello" },
    };
    expect(computeA2ACommandId(input)).toBe(computeA2ACommandId(input));
    expect(computeA2ACommandId({ ...input, executionEpoch: 4 })).not.toBe(
      computeA2ACommandId(input),
    );
  });

  it("treats changed one-shot cancel reasons as conflicting content under one stable ID", () => {
    const base = {
      executionId: "execution-1",
      executionEpoch: 1,
      attachmentId: "attachment-1",
    };
    const first = computeA2ACommandId({ ...base, command: { type: "cancel", reason: "first" } });
    const changed = computeA2ACommandId({
      ...base,
      command: { type: "cancel", reason: "changed" },
    });
    expect(changed).toBe(first);
    expect(canonicalJson({ type: "cancel", reason: "changed" })).not.toBe(
      canonicalJson({ type: "cancel", reason: "first" }),
    );
  });

  it("enforces the 2 MiB canonical frame bound", () => {
    expect(() =>
      encodeA2AProgramMessage({
        protocolVersion: 1,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executionId: "execution-1",
        program,
        executionEpoch: 1,
        type: "attach_begin",
        payload: {
          input: "x".repeat(2 * 1024 * 1024),
          inputDigest: "b".repeat(64),
          affinity: { kind: "invocation", key: "remote-task" },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "payload_too_large" } satisfies Partial<CrankError>),
    );
  });
});
