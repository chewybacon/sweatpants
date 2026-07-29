import { describe, expect, it } from "vitest";
import { sha256 } from "@sweatpants/foundation";
import { createPinnedDurableProgram } from "@sweatpants/durable-execution";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
} from "@sweatpants/foundation/schema-descriptor";
import { advertiseCapability, defineAgent, parseAgentManifest } from "../../index.ts";

const input = createPortableSchemaDescriptor({
  identity: "agent-test/input",
  role: "program_input",
  version: "1",
  vendor: "test",
  inputProjection: true,
  outputProjection: true,
  fidelity: { input: "explicit", output: "explicit" },
});
const output = createPortableSchemaDescriptor({
  identity: "agent-test/output",
  role: "program_output",
  version: "1",
  vendor: "test",
  inputProjection: true,
  outputProjection: true,
  fidelity: { input: "explicit", output: "explicit" },
});
const schemas: SchemaBinding[] = [input, output].map((descriptor) => ({
  descriptor,
  schema: standardSchemaOf("test", (value) => ({ value })),
}));
const tool = createPinnedDurableProgram(
  {
    programId: "test.program",
    version: "1",
    digest: sha256("test.program@1"),
    inputSchema: input,
    outputSchema: output,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
  },
  function* (value) {
    return value;
  },
);
const binding = { program: tool, schemas, resources: [] };
const capability = advertiseCapability({
  id: "review",
  name: "Review",
  description: "Reviews a document",
  tags: ["review"],
  examples: ["Review this"],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
  authorization: "review-documents",
});

describe("agent authoring", () => {
  it("separates canonical portable identity from runtime bindings", () => {
    const definition = defineAgent({
      identity: { name: "reviewer", version: "1" },
      description: "A reviewer",
      conversation: binding,
      programs: { run: binding },
      advertisedCapabilities: { review: capability },
    });
    expect(parseAgentManifest(definition.manifest)).toEqual(definition.manifest);
    expect(definition.manifest.identity.digest).toBe(
      "81b60d85ef548754e7ed9cb0b2abc5cf278e1c5c966dc93d394b78a6a7f1611b",
    );
    expect(definition.bindings.programs["run"]?.program).toBe(tool);
    expect(definition.manifest.programs["run"]?.provenance.kind).toBe("asserted");
    expect(() => JSON.stringify(definition)).toThrow(/manifest explicitly/);
    expect(JSON.stringify(definition.manifest)).not.toContain("durability");
  });

  it("covers every portable declaration and ignores insertion order", () => {
    const first = defineAgent({
      identity: { name: "a", version: "1" },
      description: "one",
      programs: { run: binding },
      advertisedCapabilities: { review: capability },
    });
    const reordered = defineAgent({
      identity: { name: "a", version: "1" },
      description: "one",
      advertisedCapabilities: { review: capability },
      programs: { run: binding },
    });
    const changed = defineAgent({
      identity: { name: "a", version: "1" },
      description: "two",
      programs: { run: binding },
      advertisedCapabilities: { review: capability },
    });
    expect(reordered.manifest.identity.digest).toBe(first.manifest.identity.digest);
    expect(changed.manifest.identity.digest).not.toBe(first.manifest.identity.digest);
  });

  it("fails closed for missing schemas and implicit capability identities", () => {
    expect(() =>
      defineAgent({
        identity: { name: "a", version: "1" },
        description: "x",
        programs: { run: tool },
      }),
    ).toThrowError(expect.objectContaining({ code: "program_binding_missing" }));
    expect(() =>
      defineAgent({
        identity: { name: "a", version: "1" },
        description: "x",
        programs: { run: binding },
        advertisedCapabilities: { other: capability },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_agent_manifest" }));
  });
});
