import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  MODEL_SAMPLE_EFFECT,
  MODEL_SAMPLE_SCHEMA_ENTRIES,
  createDurableProgramContext,
} from "@sweatpants/session-contract";

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
    expect(agent.bindings.programs.direct?.program).toBe(tool);
    expect(agent.bindings.programs.direct?.schemas).toEqual(tool.artifacts.catalog);
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
    expect(tool.manifest.elicits.approval?.response.inputProjection).toMatchObject({
      type: "boolean",
    });
    expect(tool.manifest.elicits.approval?.response.role).toBe("elicit_response");
    // Artifacts retain the same descriptors plus a digest-keyed validator catalog.
    expect(tool.artifacts.parameters).toEqual(tool.manifest.inputSchema);
    expect(tool.artifacts.elicits["approval"]?.response).toEqual(
      tool.manifest.elicits.approval?.response,
    );
    const digests = tool.artifacts.catalog.map((entry) => entry.descriptor.digest);
    expect(digests).toContain(tool.manifest.inputSchema.digest);
    expect(digests).toContain(tool.manifest.elicits.approval?.response.digest);
    expect(digests).toContain(echo.inputSchema.digest);
  });

  it("adds canonical sampling sugar without requiring an empty effects declaration", () => {
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
    expect(tool.manifest.effects).toEqual({ "model.sample": MODEL_SAMPLE_EFFECT });
    for (const entry of MODEL_SAMPLE_SCHEMA_ENTRIES) {
      expect(tool.artifacts.catalog).toContain(entry);
    }

    const program = tool.program({}, createDurableProgramContext());
    const first = program.next();
    expect(first.value).toMatchObject({
      type: "operation",
      descriptor: {
        kind: "effect",
        name: "model.sample",
        version: "1",
        input: {
          messages: [{ role: "user", content: "Choose a value" }],
          schema: { type: "object" },
        },
      },
    });
    const retry = program.next({
      status: "ok",
      value: { text: "bad", calls: [], content: [], parsed: { value: "bad" } },
    });
    expect(retry.value).toMatchObject({
      type: "operation",
      descriptor: { name: "model.sample" },
    });
    const completed = program.next({
      status: "ok",
      value: { text: '{"value": 7}', calls: [], content: [], parsed: { value: 7 } },
    });
    expect(completed).toEqual({ done: true, value: { value: 7 } });
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
            .execute(function* () { return null; })
        : parameters
            .effects({ echo })
            .samples()
            .execute(function* () { return null; });
    };
    expect(Object.keys(build(true).manifest.effects).sort()).toEqual(["echo", "model.sample"]);
    expect(Object.keys(build(false).manifest.effects).sort()).toEqual(["echo", "model.sample"]);
  });

  it("rejects invalid sampling request modes and retry counts before yielding", () => {
    const tool = createDurableTool("durable.invalid-sample")
      .description("Invalid sampling")
      .identity({ version: "1", digest: "1".repeat(64) })
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        return yield* context.sampleSchema({
          prompt: "x",
          messages: [] as never,
          schema: z.object({ value: z.number() }),
          retries: 11,
        } as never);
      });
    expect(() => tool.program({}, createDurableProgramContext()).next()).toThrow(/exactly one|retries/);
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
