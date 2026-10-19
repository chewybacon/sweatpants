import { canonicalJson } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import {
  decodeModelSampleRequest,
  decodeModelSampleSourceRequest,
  encodeModelSampleRequest,
  resolveModelSampleSourceRequest,
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

describe("model sample context resolution", () => {
  const source = { type: "object", object: { objectId: "context-1" }, digest: "digest-1" };

  it("rejects malformed tool definitions at source admission", () => {
    expect(() =>
      decodeModelSampleSourceRequest({
        ...request,
        invocation: { context: source },
        tools: { type: "embedded", tools: [{ name: "lookup", parameters: [] }] },
      }),
    ).toThrow();
  });

  it("owns tool definitions at admission and reuses trusted values during resolution", () => {
    const tool = {
      name: "lookup",
      description: null,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const admitted = decodeModelSampleSourceRequest({
      ...request,
      invocation: { context: source, options: { temperature: 0 } },
      tools: { type: "embedded", tools: [tool] },
    });
    tool.parameters.properties.query.type = "number";
    const context = structuredClone(request.invocation.context);
    const resolved = resolveModelSampleSourceRequest(admitted, context);

    expect(resolved.invocation.context).toBe(context);
    expect(resolved.invocation.options).toBe(admitted.invocation.options);
    expect(resolved.tools).toBe(admitted.tools);
    expect(resolved.tools).toMatchObject({
      tools: [{ parameters: { properties: { query: { type: "string" } } } }],
    });
    expect(Object.isFrozen(context.messages[0])).toBe(false);
  });

  it("still enforces collection limits on contexts assembled internally", () => {
    const admitted = decodeModelSampleSourceRequest({
      ...request,
      invocation: { context: source },
    });
    expect(() =>
      resolveModelSampleSourceRequest(admitted, {
        messages: Array.from({ length: 4_097 }, () => ({ role: "user", content: "hello" })),
        tools: [],
      }),
    ).toThrow(/messages count exceeds/);
    expect(() =>
      resolveModelSampleSourceRequest(admitted, {
        messages: [],
        tools: Array.from({ length: 1_025 }, () => ({
          name: "lookup",
          description: null,
          parameters: {},
        })),
      }),
    ).toThrow(/tools count exceeds/);
  });

  it("preserves strict context admission after the collection precheck", () => {
    expect(() =>
      decodeModelSampleRequest({
        ...request,
        invocation: { context: { ...request.invocation.context, unexpected: true } },
      }),
    ).toThrow();
  });
});
