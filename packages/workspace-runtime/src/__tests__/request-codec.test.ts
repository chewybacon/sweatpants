import { describe, expect, it } from "vitest";
import { parseWorkspaceRequest } from "../index.ts";

const request = {
  protocolVersion: 1,
  type: "read",
  fence: { taskId: "task", sandboxGeneration: "generation", activationEpoch: 1 },
  operationId: "read-1",
  path: "src/value.txt",
};

describe("workspace read request codec", () => {
  it("preserves optional line bounds until serialization without mutating the caller", () => {
    const input = { ...request, startLine: undefined, endLine: undefined };
    const value = parseWorkspaceRequest(input);
    expect(value).toStrictEqual(input);
    expect(JSON.parse(JSON.stringify(value))).toStrictEqual(request);
    expect(Object.hasOwn(input, "startLine")).toBe(true);
  });

  it.each([{ startLine: 1 }, { endLine: 2 }, { startLine: 1, endLine: 2 }])(
    "preserves independently supplied line bounds: %j",
    (bounds) => {
      const input = { ...request, ...bounds };
      expect(parseWorkspaceRequest(input)).toStrictEqual(input);
    },
  );

  it.each([{ startLine: 0 }, { endLine: null }, { path: "../secret" }])(
    "continues rejecting invalid requests: %j",
    (invalid) => {
      expect(() => parseWorkspaceRequest({ ...request, ...invalid })).toThrow();
    },
  );
});
