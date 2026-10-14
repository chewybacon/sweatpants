import {
  encodeModelSampleResult,
  MODEL_SAMPLE_CONTRACT,
  MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_SCHEMA_ENTRIES,
  ModelContextSourceStagerContext,
} from "@sweatpants/model-sampling";
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createTestDurableProgramContext,
  type TestProgramResume,
  type TestProgramStepProposal,
} from "@sweatpants/durable-execution/testing";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { assertJson } from "@sweatpants/foundation";

import { defineAgent, parseAgentManifest } from "../../agent/index.ts";
import { createDurableTool } from "../durable-create.ts";
import { defineEffect, effectCatalogEntries } from "../durable-effect.ts";

const echo = defineEffect({
  name: "echo",
  version: "1",
  input: z.string(),
  output: z.object({ echoed: z.string() }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

describe("createDurableTool fluent builder", () => {
  it("infers an ordinary Operation result without output or durable declarations", async () => {
    const tool = createDurableTool("durable.inferred")
      .description("Infer ordinary output")
      .identity({ version: "1", digest: "9".repeat(64) })
      .parameters(z.object({ value: z.string() }))
      .execute(function* (input) {
        return { value: input.value, nested: { accepted: true as const } };
      });
    expect(tool.manifest.outputSchema).toEqual(ANY_JSON_SCHEMA_DESCRIPTOR);
    const result = await run(() =>
      tool.program(
        { value: "ok" },
        createTestDurableProgramContext(() =>
          (function* (): Operation<TestProgramResume> {
            throw new Error("unexpected durable proposal");
          })(),
        ),
      ),
    );
    const exact: { value: string; nested: { accepted: true } } = result;
    expect(exact).toEqual({ value: "ok", nested: { accepted: true } });

    createDurableTool("durable.non-json")
      .description("Compile-time negative")
      .identity({ version: "1", digest: "8".repeat(64) })
      .parameters(z.object({}))
      // @ts-expect-error durable terminal results must be canonical JSON types
      .execute(function* () {
        return () => undefined;
      });
  });
  it("accepts optional object properties without producing a non-object tool schema", async () => {
    const tool = createDurableTool("durable.optional-input")
      .description("Optional canonical object properties")
      .identity({ version: "1", digest: "7".repeat(64) })
      .parameters(
        z.object({
          required: z.string(),
          optionalCount: z.number().int().optional(),
        }),
      )
      .output(z.object({ required: z.string(), optionalCount: z.number().int().optional() }))
      .execute(function* (input) {
        const optionalCount: number | undefined = input.optionalCount;
        return optionalCount === undefined
          ? { required: input.required }
          : { required: input.required, optionalCount };
      });

    expect(tool.manifest.inputSchema.inputProjection).toMatchObject({
      type: "object",
      required: ["required"],
    });
    expect(tool.manifest.inputSchema.inputProjection).not.toHaveProperty("anyOf");
    const result = await run(() =>
      tool.program(
        { required: "present" },
        createTestDurableProgramContext(() =>
          (function* (): Operation<TestProgramResume> {
            throw new Error("unexpected durable proposal");
          })(),
        ),
      ),
    );
    expect(result).toEqual({ required: "present" });
  });

  it("lowers inferred output to the built-in any descriptor and supplies a stable default effect audience", () => {
    const tool = createDurableTool("durable.echo")
      .description("Echo durably")
      .identity({ version: "1.0.0", digest: "a".repeat(64) })
      .parameters(z.object({ message: z.string() }))
      .effects({ echo })
      .execute(function* ({ message }, context) {
        return yield* context.effect(echo, message);
      });

    expect(tool.name).toBe("durable.echo");
    expect(tool.description).toBe("Echo durably");
    expect(tool.execution).toBe("crank_native");
    expect(tool.manifest.outputSchema).toEqual(ANY_JSON_SCHEMA_DESCRIPTOR);
    expect(tool.manifest.effects).toEqual({ echo });
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it("derives interface identity and binds directly without casts or binding objects", () => {
    const tool = createDurableTool("durable.direct", { version: "1.0.0" })
      .description("Directly bound")
      .parameters(z.object({ message: z.string() }))
      .output(z.object({ echoed: z.string() }))
      .effects({ echo })
      .execute(function* ({ message }) {
        return { echoed: message };
      });
    const agent = defineAgent({
      identity: { name: "direct-agent", version: "1.0.0" },
      description: "Direct binding test",
      programs: { direct: tool },
    });

    expect(tool.identityProvenance.kind).toBe("generated-interface");
    expect(agent.bindings.programs["direct"]?.program).toBe(tool);
    expect(agent.bindings.programs["direct"]?.schemas).toEqual(tool.artifacts.catalog);
    expect(parseAgentManifest(agent.manifest)).toEqual(agent.manifest);
  });

  it("accepts a build-generated implementation digest through the same validated identity path", () => {
    const tool = createDurableTool("durable.generated", {
      version: "1.0.0",
      implementationArtifactDigest: "c".repeat(64),
    })
      .description("Generated implementation")
      .parameters(z.object({}))
      .effects({})
      .execute(function* () {
        return null;
      });

    expect(tool.identityProvenance.kind).toBe("generated-artifact");
    expect(() =>
      defineAgent({
        identity: { name: "generated-agent", version: "1.0.0" },
        description: "Generated binding test",
        programs: { generated: tool },
        releaseStrict: true,
      }),
    ).not.toThrow();
  });

  it("lowers Zod output and elicit content schemas to portable descriptors in the manifest", () => {
    const tool = createDurableTool("durable.refined")
      .description("Refined")
      .identity({ version: "2", digest: "b".repeat(64) })
      .parameters(z.object({ message: z.string() }))
      .output(z.object({ echoed: z.string() }))
      .elicits({ approval: z.boolean() })
      .effects({ echo })
      .execute(function* ({ message }, context) {
        return yield* context.effect(echo, message);
      });

    expect(tool.manifest.outputSchema.outputProjection).toMatchObject({ type: "object" });
    expect(tool.manifest.outputSchema.role).toBe("program_output");
    expect(tool.manifest.elicits["approval"]?.response.inputProjection).toMatchObject({
      type: "boolean",
    });
    expect(tool.manifest.elicits["approval"]?.response.role).toBe("elicit_response");
    // ToolContract artifacts use the placement-neutral tool schema domain;
    // the catalog also retains crank-native manifest validators.
    expect(tool.artifacts.parameters.role).toBe("tool_parameters");
    expect(tool.artifacts.elicits["approval"]?.response.role).toBe("elicit_response");
    expect(tool.artifacts.parameters).not.toEqual(tool.manifest.inputSchema);
    const digests = tool.artifacts.catalog.map((entry) => entry.descriptor.digest);
    expect(digests).toContain(tool.artifacts.parameters.digest);
    expect(digests).toContain(tool.artifacts.elicits["approval"]?.response.digest);
    expect(digests).toContain(tool.manifest.inputSchema.digest);
    expect(digests).toContain(tool.manifest.elicits["approval"]?.response.digest);
    expect(digests).toContain(echo.inputSchema.digest);
  });

  it("adds canonical sampling sugar without requiring an empty effects declaration", async () => {
    const tool = createDurableTool("durable.sample")
      .description("Sample durably")
      .identity({ version: "1", digest: "d".repeat(64) })
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        const sampled = yield* context.sampleSchema({
          prompt: "Choose a value",
          schema: z.object({ value: z.number().int() }),
          retries: 1,
        });
        return sampled.parsed;
      });

    expect(tool.capabilities.sampling).toBe(true);
    expect(tool.manifest.effects).toEqual({});
    expect(tool.manifest.pulls).toEqual({
      sample: {
        input: MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
        output: MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
      },
    });
    for (const entry of MODEL_SAMPLE_PULL_SCHEMA_ENTRIES) {
      expect(tool.artifacts.catalog).toContain(entry);
    }

    const proposals: TestProgramStepProposal[] = [];
    const outcomes: TestProgramResume[] = [
      {
        status: "ok",
        value: {
          message: {
            message: { role: "assistant", content: [{ type: "text", text: "bad" }] },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: { type: "json", value: { value: "bad" } },
        },
      },
      {
        status: "ok",
        value: {
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: '{"value": 7}' }],
            },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: { type: "json", value: { value: 7 } },
        },
      },
    ];
    const result = await run(function* () {
      const context = createTestDurableProgramContext(
        (proposal): Operation<TestProgramResume> =>
          (function* () {
            proposals.push(proposal);
            return outcomes.shift();
          })(),
      );
      return yield* tool.program({}, context);
    });
    expect(proposals[0]).toMatchObject({
      type: "operation",
      descriptor: {
        kind: "sample",
        input: {
          invocation: {
            context: { messages: [{ role: "user", content: "Choose a value" }] },
          },
          tools: { type: "none" },
          response: { type: "json", schema: { type: "object" } },
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "operation",
      descriptor: { kind: "sample" },
    });
    expect(result).toEqual({ value: 7 });
  });

  it("stages workflow sample context before proposing the raw pull", async () => {
    const tool = createDurableTool("durable.sample-source")
      .description("Stage sample context")
      .identity({ version: "1", digest: "b".repeat(64) })
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        return (yield* context.sample({ prompt: "Stage me" })).text;
      });
    const descriptors: unknown[] = [];
    const base = createTestDurableProgramContext(() =>
      (function* (): Operation<TestProgramResume> {
        throw new Error("effect proposal was not expected");
      })(),
    );
    const context = {
      ...base,
      *pull(descriptor: Parameters<NonNullable<typeof base.pull>>[0]) {
        descriptors.push(descriptor);
        return encodeModelSampleResult({
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "staged" }],
            },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: { type: "message" },
        });
      },
    };

    const result = await run(function* () {
      return yield* ModelContextSourceStagerContext.with(
        function* () {
          return {
            type: "object" as const,
            object: { objectId: "context-object" },
            digest: "context-digest",
          };
        },
        () => tool.program({}, context),
      );
    });

    expect(result).toBe("staged");
    expect(descriptors).toEqual([
      {
        kind: "sample",
        input: expect.objectContaining({
          invocation: {
            context: {
              type: "object",
              object: { objectId: "context-object" },
              digest: "context-digest",
            },
          },
        }),
      },
    ]);
    expect(JSON.stringify(descriptors)).not.toContain('"messages"');
  });

  it("composes sampling and custom effects in either declaration order", () => {
    const build = (sampleFirst: boolean) => {
      const parameters = createDurableTool(`durable.order.${sampleFirst}`)
        .description("Order")
        .identity({ version: "1", digest: (sampleFirst ? "e" : "f").repeat(64) })
        .parameters(z.object({}));
      return sampleFirst
        ? parameters
            .samples()
            .effects({ echo })
            .execute(function* () {
              return null;
            })
        : parameters
            .effects({ echo })
            .samples()
            .execute(function* () {
              return null;
            });
    };
    expect(Object.keys(build(true).manifest.effects)).toEqual(["echo"]);
    expect(Object.keys(build(false).manifest.effects)).toEqual(["echo"]);
    expect(() =>
      createDurableTool("durable.reserved-sample")
        .description("Reserved")
        .identity({ version: "1", digest: "0".repeat(64) })
        .parameters(z.object({}))
        .effects({ [MODEL_SAMPLE_CONTRACT.name]: MODEL_SAMPLE_CONTRACT }),
    ).toThrow(/pull kind/);
  });

  it.each([true, false])(
    "distinguishes valid null from a parse failure (valid=%s)",
    async (valid) => {
      const tool = createDurableTool("durable.nullable-sample")
        .description("Nullable structured sample")
        .identity({ version: "1", digest: "2".repeat(64) })
        .parameters(z.object({}))
        .samples()
        .execute(function* (_input, context) {
          const result = yield* context.sampleSchema({ prompt: "Return null", schema: z.null() });
          return result.parsed;
        });
      const context = createTestDurableProgramContext(() =>
        (function* (): Operation<TestProgramResume> {
          return {
            status: "ok",
            value: {
              message: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: valid ? "null" : "broken" }],
                },
                source: null,
                usage: null,
                stopReason: null,
                responseId: null,
                errorMessage: null,
              },
              output: valid
                ? { type: "json", value: null }
                : { type: "json-invalid", error: { message: "Invalid JSON", rawText: "broken" } },
            },
          };
        })(),
      );
      const result = run(() => tool.program({}, context));
      if (valid) {
        await expect(result).resolves.toBeNull();
      } else {
        await expect(result).rejects.toMatchObject({ code: "schema_validation_failed" });
      }
    },
  );

  it("rejects invalid sampling request modes and retry counts before a proposal", async () => {
    const tool = createDurableTool("durable.invalid-sample")
      .description("Invalid sampling")
      .identity({ version: "1", digest: "1".repeat(64) })
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        const result = yield* context.sampleSchema({
          prompt: "x",
          messages: [] as never,
          schema: z.object({ value: z.number() }),
          retries: 11,
        } as never);
        return assertJson(result.parsed);
      });
    const context = createTestDurableProgramContext(() =>
      (function* (): Operation<TestProgramResume> {
        throw new Error("unexpected proposal");
      })(),
    );
    await expect(run(() => tool.program({}, context))).rejects.toThrow(/exactly one|retries/);
  });

  it("publishes effect validator catalog entries beside authored definitions", () => {
    const entries = effectCatalogEntries(echo);
    expect(entries.map((entry) => entry.descriptor.digest)).toEqual([
      echo.inputSchema.digest,
      echo.outputSchema.digest,
    ]);
  });

  it("rejects mutable or malformed identity at runtime", () => {
    expect(() =>
      createDurableTool("bad")
        .description("bad")
        .identity({ version: "latest", digest: "not-a-digest" }),
    ).toThrow(/SHA-256/);
  });
});
