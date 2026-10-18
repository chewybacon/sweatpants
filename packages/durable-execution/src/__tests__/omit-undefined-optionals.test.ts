import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { omitUndefinedOptionals } from "../omit-undefined-optionals.ts";

const schema = z.strictObject({
  id: z.string(),
  count: z.number().optional(),
  payload: z.json().optional(),
});
const normalized = omitUndefinedOptionals(schema);

describe("schema-owned optional omission", () => {
  it("preserves inferred input and output types", () => {
    expectTypeOf<z.input<typeof normalized>>().toEqualTypeOf<z.input<typeof schema>>();
    expectTypeOf<z.output<typeof normalized>>().toEqualTypeOf<z.output<typeof schema>>();
  });

  it("uses the declared optionals without mutating the input", () => {
    const input = { id: "record", count: undefined, payload: undefined };
    expect(normalized.parse(input)).toStrictEqual({ id: "record" });
    expect(Object.hasOwn(input, "count")).toBe(true);
    expect(Object.hasOwn(input, "payload")).toBe(true);
  });

  it.each([null, false, 0, "", [], {}])("preserves supplied JSON: %j", (payload) => {
    const input = { id: "record", count: 0, payload };
    expect(normalized.parse(input)).toStrictEqual(input);
  });

  it.each([
    { id: "record", unexpected: undefined },
    { id: "record", payload: { nested: undefined } },
    { id: "record", payload: [undefined] },
    { id: undefined },
  ])("retains schema rejection: %j", (input) => {
    expect(normalized.safeParse(input).success).toBe(false);
  });

  it("does not strip required fields or normalize arbitrary objects recursively", () => {
    const boundary = omitUndefinedOptionals(z.strictObject({ required: z.unknown() }));
    const input = { required: { nested: undefined } };
    expect(boundary.parse(input)).toStrictEqual(input);
    expect(boundary.parse({ required: undefined })).toStrictEqual({ required: undefined });
  });

  it("preserves defaults and optionality outside an explicit optional wrapper", () => {
    const boundary = omitUndefinedOptionals(
      z.strictObject({
        defaulted: z.string().default("default"),
        explicit: z.string().optional(),
        union: z.union([z.string(), z.undefined()]),
      }),
    );
    expect(boundary.parse({ explicit: undefined, union: undefined })).toStrictEqual({
      defaulted: "default",
      union: undefined,
    });
  });
});
