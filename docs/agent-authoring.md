# Durable chat and agent authoring

Sweatpants separates portable authoring from deployment authority:

- `@sweatpants/agent-sdk` exports `defineAgent`, `advertiseCapability`, portable `AgentManifestV1`, and local `AgentDefinition` bindings.
- `@sweatpants/chat-core` exports `defineChatProgram`, the protocol-neutral chat turn contracts, bounded context selection, resource mount helpers, and classified model-effect registration.

An `AgentDefinition` is runtime-only. Serialize `definition.manifest` explicitly; direct definition serialization throws rather than silently dropping executable, schema, or resource bindings.

## Minimal authoring

```ts
import {
  advertiseCapability,
  defineAgent,
  defineGuidance,
  defineResourcePackage,
  textResource,
} from "@sweatpants/agent-sdk";
import {
  defineChatProgram,
  latestContextWindow,
  modelReadable,
} from "@sweatpants/chat-core";

const resources = defineResourcePackage({
  id: "review-guidance",
  version: "1",
  files: { "SKILL.md": textResource("Review authority and recovery boundaries.") },
});
const guidance = defineGuidance({
  id: "reviewing",
  summary: "Use for technical design reviews.",
  package: resources,
  entryPath: "SKILL.md",
});
const conversation = defineChatProgram({
  identity: { name: "review.chat", version: "1" },
  systemPrompt: { text: "You are a technical reviewer.", classification: "internal" },
  guidance: [guidance],
  resources: {
    reviewing: modelReadable(resources, { classification: "internal" }),
  },
  contextPolicy: latestContextWindow(),
});
const agent = defineAgent({
  identity: { name: "reviewer", version: "1" },
  description: "Reviews technical designs.",
  conversation,
  programs: { review: conversation },
  advertisedCapabilities: {
    review: advertiseCapability({
      id: "review",
      name: "Technical review",
      description: "Reviews RFCs and architecture proposals.",
      tags: ["architecture", "review"],
      examples: ["Review this design"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      authorization: "review-designs",
    }),
  },
});
```

Guidance, model tools, exact entrypoints, and advertised capabilities are independent declarations. Guidance is advisory and only its bounded index enters initial model context. Full content is loaded through exact durable resource-reader children.

## Durable tools without binding ceremony

```ts
const lookup = createDurableTool("lookup", { version: "1.0.0" })
  .description("Look up one record")
  .parameters(z.object({ id: z.string() }))
  .output(z.object({ name: z.string() }))
  .effects({ lookupRecord })
  .execute(function* ({ id }, context) {
    return yield* context.effect(lookupRecord, { id });
  });

const conversation = defineChatProgram({
  // ...
  tools: {
    lookup: modelTool(lookup, { resultClassification: "internal" }),
  },
});

const agent = defineAgent({
  // ...
  programs: { lookup },
});
```

A fluent durable tool is itself an `AgentProgramInput`. `defineChatProgram()` and `defineAgent()` derive its runtime schema catalog and empty resource list; authors do not construct `AgentProgramBinding` objects or cast tools to low-level types.

### Validator-neutral schemas

Authoring accepts Standard Schema V1 directly. Zod 4 remains a zero-adapter option, while a custom validator can provide the same runtime contract:

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec";

const countSchema: StandardSchemaV1<unknown, { count: number }> = {
  "~standard": {
    version: 1,
    vendor: "example-validator",
    validate(value) {
      return typeof value === "object" && value !== null && "count" in value
        ? { value: { count: Number((value as { count: unknown }).count) } }
        : { issues: [{ message: "count is required" }] };
    },
  },
};

const portableCountTool = createDurableTool("count", { version: "1.0.0" })
  .description("Count a value")
  .parameters(countSchema, {
    inputProjection: { type: "object", properties: { count: { type: "number" } } },
    outputProjection: { type: "number" },
  })
  .execute(function* ({ count }) {
    return count;
  });
```

The validator object remains process-local. Durable manifests carry only its digest-bearing descriptor and the explicit projections; restore selects the exact runtime binding by digest.

Omitting a digest creates deterministic `generated-interface` provenance from the complete durable manifest: program name and version, schemas, effects, elicitations, and capabilities. This identity deliberately does **not** claim to cover executor source and is rejected by `releaseStrict`. Build tooling can instead supply `implementationArtifactDigest` in the `createDurableTool` options to use the existing validated `generated-artifact` path. Explicit `.identity({ version, digest })` remains the asserted low-level escape hatch. Runtime correctness never depends on a build plugin.

Model-visible durable tools should be wrapped with `modelTool(tool, { resultClassification })`. The declared classification ceiling taints every returned value independently of payload shape; direct legacy tool declarations conservatively default to `restricted`. A tool may raise, but never lower, that ceiling with the explicit `classifiedToolResult` envelope. Ordinary output fields named `classifications` or `sources` have no provenance meaning. The `resources.*` namespace is reserved for generated readers.

Authored-chat v1 rejects non-empty `elicitations` because the v1 model output algebra cannot trigger an elicitation. This prevents publishing dead manifest declarations; model-triggered elicitation requires a future explicit call type.

Model providers, routes, credentials, endpoints, quotas, journals, effect handlers, and grants are deployment bindings and do not enter chat or agent identity. Use `createChatModelEffectRegistration` to authorize the classification union attached to each exact `model.sample` payload before provider invocation.
