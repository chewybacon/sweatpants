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
  it("normalizes known optionals consistently when parsing and encoding", () => {
    const input = {
      ...request,
      invocation: { ...request.invocation, options: undefined },
      modelPreferences: undefined,
      classifications: undefined,
    };
    expect(decodeModelSampleRequest(input)).toStrictEqual(request);
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
    expect(decodeModelSampleRequest(input)).toStrictEqual(expected);
    expect(
      encodeModelSampleRequest({ ...request, invocation: { ...request.invocation, options: {} } }),
    ).toHaveProperty("invocation.options", {});
    expect(Object.hasOwn(input.invocation.options, "maxTokens")).toBe(true);
  });

  it("rejects undefined inside arbitrary JSON payloads", () => {
    const input = { ...request, modelPreferences: { nested: undefined } };
    expect(() => decodeModelSampleRequest(input)).toThrow();
    expect(() => {
      // @ts-expect-error Exercise invalid JSON arriving from an untyped caller.
      encodeModelSampleRequest(input);
    }).toThrow();
  });
});
