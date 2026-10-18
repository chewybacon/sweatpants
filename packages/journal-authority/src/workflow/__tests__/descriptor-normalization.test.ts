import { canonicalJson } from "@sweatpants/foundation";
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

describe("descriptor normalization", () => {
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
    expect(authored.value).toStrictEqual(expected);
    expect(command.value.descriptor).toStrictEqual(expected);
    expect(canonicalJson(authored.value)).toBe(canonicalJson(command.value.descriptor));
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
