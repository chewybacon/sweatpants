# Durable chat and agent authoring

Sweatpants separates portable authoring from deployment authority:

- `@sweatpants/core` exports `defineAgent`, `advertiseCapability`, portable `AgentManifestV1`, and local `AgentDefinition` bindings.
- `@sweatpants/framework/chat` exports `defineChatProgram`, the protocol-neutral chat turn contracts, bounded context selection, resource mount helpers, and classified model-effect registration.
- `@sweatpants/framework/server` exports explicit `remoteExecutor`, `standardA2A`, and `sweatpantsPeer` profiles, `serveAgent`, and posture-specific connection APIs.

An `AgentDefinition` is runtime-only. Serialize `definition.manifest` explicitly; direct definition serialization throws rather than silently dropping executable, schema, or resource bindings.

## Minimal authoring

```ts
import {
  advertiseCapability,
  defineAgent,
  defineGuidance,
  defineResourcePackage,
  textResource,
} from "@sweatpants/core";
import {
  defineChatProgram,
  latestContextWindow,
  modelReadable,
} from "@sweatpants/framework/chat";

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

Model-visible durable tools should be wrapped with `modelTool(binding, { resultClassification })`. The declared classification ceiling taints every returned value independently of payload shape; direct legacy tool declarations conservatively default to `restricted`. A tool may raise, but never lower, that ceiling with the explicit `classifiedToolResult` envelope. Ordinary output fields named `classifications` or `sources` have no provenance meaning. The `resources.*` namespace is reserved for generated readers.

Authored-chat v1 rejects non-empty `elicitations` because the v1 model output algebra cannot trigger an elicitation. This prevents publishing dead manifest declarations; model-triggered elicitation requires a future explicit call type.

## Explicit authority posture

```ts
import { remoteExecutor, serveAgent } from "@sweatpants/framework/server";

const served = serveAgent(
  agent,
  remoteExecutor({
    deployment: {
      interfaceUrl: "https://agent.example/a2a",
      manifestEndpoint: "https://agent.example/manifests",
      driverEndpoint: "wss://agent.example/driver",
    },
    bindings: { review: "review" },
  }),
);
```

There is no default posture. `remoteExecutor()` retains caller-owned journals and effects. `standardA2A()` requires callee-local effect handlers and does not report readiness until a conforming standard task host is installed. `sweatpantsPeer()` compiles exact effect requirements and explicit local/caller routes; grants remain per-invocation state.

Model providers, routes, credentials, endpoints, quotas, journals, effect handlers, and grants are deployment bindings and do not enter chat or agent identity. Use `createChatModelEffectRegistration` to authorize the classification union attached to each exact `model.sample` payload before provider invocation.

## Journal-backed standard serving

```ts
import {
  createStandardA2AHost,
  serveAgent,
  standardA2A,
} from "@sweatpants/framework/server";

const served = serveAgent(
  agent,
  standardA2A({
    deployment: { interfaceUrl: "https://agent.example/a2a" },
    handlers: [modelSampleHandler, ...localEffectHandlers],
    capabilityBindings: {},
    historyProjection: "accepted-context",
    host: createStandardA2AHost({
      authenticate: authenticateHttpRequest,
      authorize: authorizeAgentAction,
    }),
  }),
);
```

The bound host exposes Agent Card discovery, task-generating HTTP+JSON send,
task-scoped retrieval, exact-task cancellation, and SSE snapshots. A context is
scoped to the authenticated principal/tenant journal, each ordinary turn gets a
new immutable task, and explicit ordered `referenceTaskIds` are preserved.
Production card/interface URLs must use HTTPS. Local HTTP requires
`insecureLoopbackDevelopment: true` on the deployment.

`historyProjection` controls only the public A2A Task history. The
`accepted-context` default prepends the immutable bounded context snapshot that
was accepted with the task; `task-only` exposes only the current turn,
elicitation prompts/responses, and final result. Model memory always follows the
chat program's pinned context policy. A live, growing conversation is never
projected into an already-terminal task.

Use `startAgentHarness` from `@sweatpants/framework/server/testing` for a real
loopback HTTP server and discovery in tests. The evidence API exposes IDs,
digests, journal event kinds, lineage, and state without credentials or content
bodies.

## Frontier ownership and host certification

`selectChatContext` is a pure selector over a host-supplied projection. The accepting journal host must capture a pre-open frontier, read all candidate messages and referenced-task summaries at that frontier, and persist the selected view once in `TaskOpened`. The selector cannot prove that an opaque frontier string and candidate array came from the same journal snapshot.

The standard host captures this frontier before opening each root task and commits the selected bounded view in the exact accepted `TaskOpened` input. Host integration tests certify that replay reads the accepted input rather than rerunning context selection.
