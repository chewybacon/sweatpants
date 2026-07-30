import { run } from "effection";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";

import { parseToolParameters, ToolParameterValidationError } from "./tool-parameters.ts";

function schema(
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("parseToolParameters", () => {
  it("accepts a non-Zod Standard Schema and returns transformed output", async () => {
    const upper = schema((value) =>
      typeof value === "string"
        ? { value: value.trim().toUpperCase() }
        : { issues: [{ message: "expected string" }] },
    );

    await expect(
      run(function* () {
        return yield* parseToolParameters({
          schema: upper,
          params: "  hello ",
          toolName: "upper",
          callId: "call-1",
        });
      }),
    ).resolves.toBe("HELLO");
  });

  it("adopts an asynchronous Standard Schema validator", async () => {
    const asyncSchema = schema(async (value) => ({ value }));
    await expect(
      run(function* () {
        return yield* parseToolParameters({
          schema: asyncSchema,
          params: { ok: true },
          toolName: "async",
          callId: "call-2",
        });
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("fails closed for rejected input and unsupported runtime schema values", async () => {
    const rejected = schema(() => ({ issues: [{ path: ["secret"], message: "expected string" }] }));
    const rejection = run(function* () {
      return yield* parseToolParameters({
        schema: rejected,
        params: {},
        toolName: "rejected",
        callId: "call-3",
      });
    });
    await expect(rejection).rejects.toBeInstanceOf(ToolParameterValidationError);
    await expect(rejection).rejects.toMatchObject({
      payload: {
        issues: [{ path: ["secret"], message: "expected string" }],
        message: expect.stringContaining("secret: expected string"),
      },
    });

    await expect(
      run(function* () {
        return yield* parseToolParameters({
          schema: {} as StandardSchemaV1,
          params: {},
          toolName: "unsupported",
          callId: "call-4",
        });
      }),
    ).rejects.toBeInstanceOf(ToolParameterValidationError);
  });
});
