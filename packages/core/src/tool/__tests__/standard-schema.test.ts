import { run } from "effection";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createDurableSchemaRegistry, validateRegisteredSchema } from "@sweatpants/session-contract";

import { toPortableSchema } from "../../schema/zod-adapter.ts";
import { createTool } from "../create.ts";

describe("Zod Standard Schema adapter", () => {
  it("generates role-specific draft-2020-12 input/output projections", () => {
    const lowered = toPortableSchema(z.object({ name: z.string().default("Ada") }), {
      identity: "tool:test/parameters",
      role: "tool_parameters",
      version: "1",
    });
    expect(lowered.descriptor.inputProjection).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    });
    expect(lowered.descriptor.outputProjection).toMatchObject({ type: "object" });
    expect(lowered.descriptor.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs Zod defaults/transforms once through the registered Standard Schema validator", async () => {
    const schema = z.string().trim().transform((value) => value.toUpperCase());
    const lowered = toPortableSchema(schema, {
      identity: "tool:test/transformed",
      role: "tool_parameters",
      version: "2",
      outputProjection: { type: "string" },
    });
    await expect(
      run(function* () {
        return yield* validateRegisteredSchema(
          createDurableSchemaRegistry([lowered.entry]),
          lowered.descriptor.digest,
          "  hello ",
        );
      }),
    ).resolves.toEqual({ status: "ok", value: "HELLO" });
    expect(lowered.descriptor.fidelity.output).toBe("explicit");
  });

  it("fails authoring when transformed output has no explicit trusted projection", () => {
    expect(() =>
      toPortableSchema(z.string().transform((value) => value.length), {
        identity: "tool:test/unprojectable",
        role: "tool_output",
        version: "1",
      }),
    ).toThrow(/schema projection|explicit trusted projection/i);
  });

  it("ordinary definitions expose one execution-neutral contract plus callable execution", async () => {
    const tool = createTool("standard_schema_tool")
      .description("standard")
      .parameters(z.object({ count: z.coerce.number().int().default(2) }))
      .execute(function* ({ count }) {
        return count;
      });
    expect(tool.execution).toBe("ordinary");
    expect(tool.artifacts.parameters.role).toBe("tool_parameters");
    expectTypeOf(tool).toBeCallableWith({} as never);
    const invoke = await run(function* () {
      return yield* tool({} as never);
    });
    await expect(run(() => invoke({ count: "3" } as never))).resolves.toBe(3);
  });
});
