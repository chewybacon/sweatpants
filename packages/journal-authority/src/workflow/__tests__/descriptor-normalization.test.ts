import { allDescriptorSchema, raceDescriptorSchema } from "../../pull-kinds/children.ts";
import { encodeCanonicalJson, type Json } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import {
  effectOptionsParser,
  elicitOptionsParser,
  programCommandParser,
  waitOptionsParser,
} from "../runtime.ts";

const response = {
  identity: "schema:confirm",
  role: "elicitation_response",
  version: "1",
  vendor: "test",
  inputProjection: true,
  outputProjection: true,
  fidelity: { input: "lossless", output: "lossless" },
  digest: "digest",
};

describe("descriptor admission and serialization", () => {
  it.each([
    {
      kind: "elicit",
      parser: elicitOptionsParser,
      options: {
        key: "confirm",
        message: "Proceed?",
        response,
        context: undefined,
        contextContract: undefined,
        binding: undefined,
      },
      expected: { kind: "elicit", key: "confirm", message: "Proceed?", response },
    },
    {
      kind: "elicit",
      parser: elicitOptionsParser,
      options: {
        key: "confirm",
        message: "Proceed?",
        response,
        context: false,
        contextContract: response,
        binding: { id: "binding" },
      },
      expected: {
        kind: "elicit",
        key: "confirm",
        message: "Proceed?",
        response,
        context: false,
        contextContract: response,
        binding: { id: "binding" },
      },
    },
    {
      kind: "effect",
      parser: effectOptionsParser,
      options: {
        name: "sample",
        version: "1",
        input: null,
        resolver: { audience: "host", route: undefined },
      },
      expected: {
        kind: "effect",
        name: "sample",
        version: "1",
        input: null,
        resolver: { audience: "host" },
      },
    },
    {
      kind: "effect",
      parser: effectOptionsParser,
      options: {
        name: "sample",
        version: "1",
        input: null,
        resolver: { audience: "host", route: "" },
      },
      expected: {
        kind: "effect",
        name: "sample",
        version: "1",
        input: null,
        resolver: { audience: "host", route: "" },
      },
    },
    {
      kind: "wait",
      parser: waitOptionsParser,
      options: { key: "wait", notBefore: undefined, durationMs: undefined },
      expected: { kind: "wait", key: "wait" },
    },
    {
      kind: "wait",
      parser: waitOptionsParser,
      options: { key: "wait", notBefore: "", durationMs: 1 },
      expected: { kind: "wait", key: "wait", notBefore: "", durationMs: 1 },
    },
  ])("authoring and command admission agree for $kind", ({ kind, parser, options, expected }) => {
    const original = structuredClone(options);
    const authored = parser.parse(options);
    const command = programCommandParser.parse({
      type: "authorize-record",
      actionIndex: 0,
      pullId: "pull",
      attemptId: "attempt",
      descriptor: { kind, ...options },
    });
    expect(authored.ok).toBe(true);
    expect(command.ok).toBe(true);
    if (!authored.ok || !command.ok || command.value.type !== "authorize-record") {
      throw new Error("expected a valid descriptor at both boundaries");
    }
    expect(authored.value).toStrictEqual({ kind, ...options });
    expect(command.value.descriptor).toStrictEqual(authored.value);
    const wire = encodeCanonicalJson(authored.value as unknown as Json);
    expect(JSON.parse(wire)).toStrictEqual(expected);
    expect(wire).toBe(encodeCanonicalJson(command.value.descriptor as unknown as Json));
    expect(options).toStrictEqual(original);
    if (kind === "effect" || kind === "wait") {
      expect(Object.isFrozen(authored.value)).toBe(true);
    }
  });

  it("continues rejecting undefined inside arbitrary JSON context", () => {
    const options = {
      key: "confirm",
      message: "Proceed?",
      response,
      context: { nested: undefined },
    };
    expect(elicitOptionsParser.parse(options).ok).toBe(false);
    expect(
      programCommandParser.parse({
        type: "authorize-record",
        actionIndex: 0,
        pullId: "pull",
        attemptId: "attempt",
        descriptor: { kind: "elicit", ...options },
      }).ok,
    ).toBe(false);
  });
});

describe("command optional fields", () => {
  const receipt = {
    sessionId: "session",
    taskId: "task",
    pullId: "pull",
    resolutionOffset: "0",
    outcomeDigest: "a".repeat(64),
    status: "accepted",
  };

  it.each([
    [{ status: "cancelled", partial: undefined }, { status: "cancelled" }],
    [
      { status: "cancelled", partial: null },
      { status: "cancelled", partial: null },
    ],
    [
      { status: "cancelled", partial: false },
      { status: "cancelled", partial: false },
    ],
    [
      { status: "error", error: { code: "failed", message: "Failed", details: undefined } },
      { status: "error", error: { code: "failed", message: "Failed" } },
    ],
    [
      { status: "error", error: { code: "failed", message: "Failed", details: 0 } },
      { status: "error", error: { code: "failed", message: "Failed", details: 0 } },
    ],
  ])("preserves optional outcome fields until serialization: %j", (outcome, expected) => {
    const input = { type: "resume-record", actionIndex: 0, outcome, receipt, replayed: false };
    const original = structuredClone(input);
    const result = programCommandParser.parse(input);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== "resume-record") {
      throw new Error("expected a valid resume command");
    }
    const parsed = result.value.outcome;
    expect(parsed).toStrictEqual(outcome);
    expect(JSON.parse(encodeCanonicalJson(parsed))).toStrictEqual(expected);
    expect(input).toStrictEqual(original);
  });

  it.each([undefined, ""])("preserves cancellation reason semantics: %j", (reason) => {
    const result = programCommandParser.parse({ type: "cancel", reason });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a valid cancel command");
    }
    expect(result.value).toStrictEqual({ type: "cancel", reason });
    expect(JSON.parse(JSON.stringify(result.value))).toStrictEqual(
      reason === undefined ? { type: "cancel" } : { type: "cancel", reason },
    );
  });

  it.each(["all", "race"])("preserves %s child durability until serialization", (kind) => {
    const base = { id: "child", version: "1", digest: "digest", input: null };
    const native = { ...base, durability: { kind: "crank_native" } };
    const input = {
      type: "authorize-record",
      actionIndex: 0,
      pullId: "pull",
      attemptId: "attempt",
      descriptor: {
        kind,
        supervision: kind === "all" ? "one_for_all" : "first_success",
        children: [{ ...base, durability: undefined }, native],
        expiry: { kind: "inherit" },
      },
    };
    const original = structuredClone(input);
    const schema = kind === "all" ? allDescriptorSchema : raceDescriptorSchema;
    const result = schema.parse(input.descriptor);
    expect(result.children).toStrictEqual(input.descriptor.children);
    expect(JSON.parse(encodeCanonicalJson(result)).children).toStrictEqual([base, native]);
    expect(input).toStrictEqual(original);
  });

  it.each([
    { status: "cancelled", partial: { nested: undefined } },
    {
      status: "error",
      error: { code: "failed", message: "Failed", details: { nested: undefined } },
    },
  ])("rejects undefined within outcome JSON: %j", (outcome) => {
    expect(
      programCommandParser.parse({
        type: "resume-record",
        actionIndex: 0,
        outcome,
        receipt,
        replayed: false,
      }).ok,
    ).toBe(false);
  });
});
