import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { parseToolParameters } from "../tool-parameters.ts";

function schema(
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("parseToolParameters", () => {
  it("accepts a non-Zod Standard Schema and returns transformed output", () => {
    const upper = schema((value) =>
      typeof value === "string"
        ? { value: value.trim().toUpperCase() }
        : { issues: [{ message: "expected string" }] },
    );

    expect(
      parseToolParameters({
        schema: upper,
        params: "  hello ",
        toolName: "upper",
        callId: "call-1",
      }),
    ).toEqual({ status: "ok", value: "HELLO" });
  });

  it("rejects an asynchronous Standard Schema validator", () => {
    const asyncSchema = schema(async (value) => ({ value }));
    expect(
      parseToolParameters({
        schema: asyncSchema,
        params: { ok: true },
        toolName: "async",
        callId: "call-2",
      }),
    ).toEqual({ status: "schema-error", reason: "async-unsupported" });
  });

  it("returns invalid input and unsupported schema results", () => {
    const rejected = schema(() => ({ issues: [{ path: ["secret"], message: "expected string" }] }));
    expect(
      parseToolParameters({
        schema: rejected,
        params: {},
        toolName: "rejected",
        callId: "call-3",
      }),
    ).toEqual({
      status: "invalid",
      issues: [{ path: ["secret"], message: "expected string" }],
    });

    expect(
      parseToolParameters({
        schema: {} as StandardSchemaV1,
        params: {},
        toolName: "unsupported",
        callId: "call-4",
      }),
    ).toEqual({ status: "schema-error", reason: "invalid-interface" });
  });
});
