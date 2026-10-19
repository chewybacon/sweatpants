import { canonicalJson } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import {
  decodeModelSampleRequest,
  encodeModelSampleRequest,
  type ModelSampleRequest,
} from "../contract.ts";

const request: ModelSampleRequest = {
  invocation: { context: { messages: [{ role: "user", content: "hello" }], tools: [] } },
  tools: { type: "none" },
  response: { type: "message" },
};

describe("model sample request codec", () => {
  it("preserves optionals internally and omits them during encoding", () => {
    const input = {
      ...request,
      invocation: { ...request.invocation, options: undefined },
      modelPreferences: undefined,
      classifications: undefined,
    };
    expect(decodeModelSampleRequest(input)).toStrictEqual(input);
    expect(encodeModelSampleRequest(input)).toStrictEqual(request);
    expect(canonicalJson(encodeModelSampleRequest(input))).toBe(canonicalJson(request));
    expect(Object.hasOwn(input.invocation, "options")).toBe(true);
  });

  it("keeps supplied empty options, zero settings, null preferences, and empty classifications", () => {
    const input = {
      ...request,
      invocation: {
        ...request.invocation,
        options: { maxTokens: undefined, temperature: 0, topP: 0 },
      },
      modelPreferences: null,
      classifications: [],
    };
    const expected = {
      ...input,
      invocation: { ...input.invocation, options: { temperature: 0, topP: 0 } },
    };
    expect(encodeModelSampleRequest(input)).toStrictEqual(expected);
    expect(decodeModelSampleRequest(input)).toStrictEqual(input);
    expect(
      encodeModelSampleRequest({ ...request, invocation: { ...request.invocation, options: {} } }),
    ).toHaveProperty("invocation.options", {});
    expect(Object.hasOwn(input.invocation.options, "maxTokens")).toBe(true);
  });

  it("encodes a detached wire value with optional response metadata", () => {
    const input: ModelSampleRequest = {
      ...request,
      response: { type: "json", schema: { type: "string" }, name: undefined },
      invocation: {
        context: structuredClone(request.invocation.context),
        options: { temperature: 0, topP: undefined },
      },
    };
    const decoded = decodeModelSampleRequest(input);
    const wire = encodeModelSampleRequest(input);
    expect(Object.isFrozen(decoded.invocation.context.messages[0])).toBe(true);
    expect(wire.response).toStrictEqual({ type: "json", schema: { type: "string" } });
    expect(wire.invocation).toMatchObject({ options: { temperature: 0 } });
    input.invocation.context.messages[0]!.content = "changed";
    expect(JSON.stringify(wire)).toContain("hello");
    expect(JSON.stringify(wire)).not.toContain("changed");
    expect(decodeModelSampleRequest(wire).response).toStrictEqual({
      type: "json",
      schema: { type: "string" },
    });
  });

  it("rejects undefined inside arbitrary JSON payloads at admission", () => {
    const input = { ...request, modelPreferences: { nested: undefined } };
    expect(() => decodeModelSampleRequest(input)).toThrow();
  });
});
