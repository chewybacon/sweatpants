import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/session-contract";

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
