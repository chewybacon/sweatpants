import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  failure,
  parser,
  SchemaImplementationError,
  success,
  validateAuthoredSchema,
  type ParseResult,
} from "./parser.ts";

function schema<Output = unknown>(
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> {
  return { "~standard": { version: 1 as const, vendor: "test", validate } };
}

describe("result-oriented parser", () => {
  it("returns success and failure results with structured paths", () => {
    const valueParser = parser(
      schema((value) =>
        typeof value === "object" && value !== null
          ? { value }
          : { issues: [{ path: ["input"], message: "expected object", code: "object" }] },
      ),
    );

    expect(valueParser.parse({ ok: true })).toEqual({ ok: true, value: { ok: true } });
    expect(valueParser.parse("wrong")).toEqual({
      ok: false,
      issues: [{ path: ["input"], message: "expected object", code: "object" }],
    });
    expect(failure({ path: [], message: "invalid" })).toEqual({
      ok: false,
      issues: [{ path: [], message: "invalid" }],
    });
    expect(success(3)).toEqual({ ok: true, value: 3 });
  });

  it("composes successful values and short-circuits failures", () => {
    let mapCalls = 0;
    let verifyCalls = 0;
    const base = parser<unknown, number>(
      schema<number>((value) =>
        typeof value === "number" ? { value } : { issues: [{ message: "number" }] },
      ),
    );
    const composed = base
      .map((value) => {
        mapCalls += 1;
        return value + 1;
      })
      .andThen((value): ParseResult<string> => {
        verifyCalls += 1;
        return value > 1 ? success(String(value)) : failure({ path: [], message: "too small" });
      });

    expect(composed.parse(2)).toEqual({ ok: true, value: "3" });
    expect(composed.parse("no")).toEqual({
      ok: false,
      issues: [{ path: [], message: "number" }],
    });
    expect(mapCalls).toBe(1);
    expect(verifyCalls).toBe(1);
  });

  it("does not convert thrown transforms to invalid input", () => {
    const sentinel = new Error("programmer error");
    const valueParser = parser(schema(() => ({ value: 1 }))).map(() => {
      throw sentinel;
    });

    expect(() => valueParser.parse(null)).toThrow(sentinel);
  });

  it("rejects asynchronous and thrown validators without retaining data", () => {
    const secret = { secret: "do-not-retain" };
    const asyncParser = parser(schema(() => Promise.resolve({ value: secret })));
    expect(() => asyncParser.parse(secret)).toThrowError(SchemaImplementationError);
    try {
      asyncParser.parse(secret);
    } catch (error) {
      expect(error).toMatchObject({
        name: "SchemaImplementationError",
        reason: "async-unsupported",
      });
      expect(error).not.toHaveProperty("cause");
    }

    const thrownParser = parser(
      schema(() => {
        throw secret;
      }),
    );
    expect(() => thrownParser.parse(secret)).toThrowError(SchemaImplementationError);
    try {
      thrownParser.parse(secret);
    } catch (error) {
      expect(error).toMatchObject({ name: "SchemaImplementationError", reason: "validator-threw" });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("input");
    }
  });

  it("bounds and redacts source issues", () => {
    const valueParser = parser(
      schema(() => ({
        issues: Array.from({ length: 20 }, (_, index) => ({
          path: [{ key: "x".repeat(300) }, index],
          message: "m".repeat(700),
          code: "c".repeat(200),
          rejected: { secret: true },
        })),
      })),
    );
    const result = valueParser.parse({ secret: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(16);
    expect(result.issues[0]?.message).toHaveLength(512);
    expect(JSON.stringify(result.issues[0])).not.toContain("secret");
    expect(JSON.stringify(result.issues[0])).not.toContain("rejected");
    expect(result.issues[0]?.path.join(".").length).toBeLessThanOrEqual(256);
    expect(result.issues[0]?.code?.length).toBeLessThanOrEqual(128);
  });

  it("separates authored invalid input from schema errors", () => {
    const valid = validateAuthoredSchema<string>(
      schema((value) =>
        typeof value === "string"
          ? { value: value.toUpperCase() }
          : { issues: [{ message: "string" }] },
      ),
      "hello",
    );
    expect(valid).toEqual({ status: "ok", value: "HELLO" });
    expect(
      validateAuthoredSchema(
        schema(() => ({ issues: [{ message: "bad" }] })),
        1,
      ),
    ).toEqual({
      status: "invalid",
      issues: [{ path: [], message: "bad" }],
    });
    expect(validateAuthoredSchema({}, 1)).toEqual({
      status: "schema-error",
      reason: "invalid-interface",
    });
    expect(
      validateAuthoredSchema(
        schema(() => Promise.resolve({ value: 1 })),
        1,
      ),
    ).toEqual({
      status: "schema-error",
      reason: "async-unsupported",
    });
  });
});
