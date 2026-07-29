import { CrankError } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  type Json,
} from "@sweatpants/foundation";
import type { PortableSchemaDescriptor, SchemaBinding } from "@sweatpants/foundation/schema";
import {
  MODEL_SAMPLE_EFFECT,
  MODEL_SAMPLE_SCHEMA_ENTRIES,
  createDurableEffectRegistration,
  type DurableEffectContext,
  type DurableEffectDisposition,
  type DurableEffectRegistration,
  type ModelSampleRequest,
  type ModelSampleResult,
} from "@sweatpants/durable-effects";
import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  generateProgramArtifactIdentity,
  type DurableProgramManifest,
  type DurableTool,
} from "@sweatpants/durable-execution";
import { validateEffectDefinition } from "@sweatpants/durable-effects/authoring";
import type { EffectDefinition } from "@sweatpants/durable-effects";
import {
  ResourcePackageRegistry,
  defineResourceView,
  effectCatalogEntries,
  generateResourceReaders,
  guidanceIndex,
  sortedResourceValues as sortedValues,
  type AgentProgramBinding,
  type AgentProgramInput,
  type DataClassification,
  type GuidanceDefinition,
  type ResourceMount,
  type ResourceMountAccess,
  type ResourcePackage,
  type ResourceReaderPrograms,
  type ResourceView,
} from "@sweatpants/agent-sdk";
import {
  CHAT_CONTRACT_SCHEMA_ENTRIES,
  CHAT_TURN_INPUT_DESCRIPTOR,
  CHAT_TURN_RESULT_DESCRIPTOR,
  CHAT_TURN_RESULT_FORMAT,
  normalizeChatMessage,
  normalizeChatTurnResult,
  normalizeContentPart,
  normalizeModelSampleOutput,
  type ChatContentPartV1,
  type ChatContextPolicyV1,
  type ChatMessageV1,
  type ChatModelSampleInputV2,
  type ChatModelSampleOutputV2,
  type ChatTurnInputV1,
  type ChatTurnResultV1,
} from "./contracts.ts";
import { chatPayloadClassifications, latestContextWindow } from "./context.ts";

export const GENERIC_CHAT_ENGINE = Object.freeze({
  id: "sweatpants.authored-chat-engine",
  version: "1",
  digest: sha256("sweatpants.authored-chat-engine.v1"),
});
export const CHAT_PROGRAM_IDENTITY_DOMAIN = "sweatpants.authored-chat-program.v1\n";

export interface ChatResourceMountDeclaration {
  readonly package: ResourcePackage;
  readonly access: ResourceMountAccess;
}
export interface ChatSystemPrompt {
  readonly text: string;
  readonly classification: DataClassification;
}
export interface ChatModelToolDeclaration {
  readonly kind: "sweatpants.chat-model-tool.v1";
  readonly binding: AgentProgramInput;
  /** Conservative classification ceiling applied independently of tool output bytes. */
  readonly resultClassification: DataClassification;
}
export interface ClassifiedToolResultV1 {
  readonly format: "sweatpants.classified-tool-result.v1";
  readonly value: Json;
  readonly provenance: {
    readonly classifications: readonly DataClassification[];
    readonly sourceDigests: readonly string[];
  };
}
export interface ChatSamplingPolicyV1 {
  readonly maxTokens?: number;
  readonly toolChoice?: "auto" | "none" | "required";
  readonly requirements?: readonly string[];
}
export interface DefineChatProgramOptions {
  readonly identity: { readonly name: string; readonly version: string };
  readonly systemPrompt: ChatSystemPrompt;
  readonly guidance?: readonly GuidanceDefinition[];
  readonly resources?: Readonly<Record<string, ChatResourceMountDeclaration>>;
  readonly tools?: Readonly<Record<string, ChatModelToolDeclaration>>;
  readonly effects?: Readonly<Record<string, EffectDefinition<Json, Json, Json>>>;
  readonly elicitations?: Readonly<
    Record<
      string,
      { readonly response: PortableSchemaDescriptor; readonly context?: PortableSchemaDescriptor }
    >
  >;
  readonly contextPolicy?: ChatContextPolicyV1;
  readonly maxIterations?: number;
  /** Runtime validators for low-level effect/elicitation descriptors not authored through core helpers. */
  readonly schemaCatalog?: readonly SchemaBinding[];
  readonly sampling?: ChatSamplingPolicyV1;
}
export type ChatProgramDefinition = DurableTool<ChatTurnInputV1 & Json, ChatTurnResultV1 & Json> & {
  readonly kind: "sweatpants.chat-program.v1";
  readonly schemaCatalog: readonly SchemaBinding[];
  readonly resourcePackages: readonly ResourcePackage[];
  readonly resourceView: ResourceView;
  readonly resourceReaders: ResourceReaderPrograms;
  readonly resourceRegistry: ResourcePackageRegistry;
  readonly childPrograms: Readonly<Record<string, AgentProgramBinding>>;
  readonly toolResultClassifications: Readonly<Record<string, DataClassification>>;
  readonly configuration: Json;
  readonly contextPolicy: ChatContextPolicyV1;
};

export const CHAT_MODEL_SAMPLE_EFFECT = MODEL_SAMPLE_EFFECT;

export function programPrivate(resourcePackage: ResourcePackage): ChatResourceMountDeclaration {
  return Object.freeze({
    package: resourcePackage,
    access: Object.freeze({ kind: "program_private" }),
  });
}
export function modelReadable(
  resourcePackage: ResourcePackage,
  options: { readonly classification: DataClassification },
): ChatResourceMountDeclaration {
  return Object.freeze({
    package: resourcePackage,
    access: Object.freeze({ kind: "model_readable", classification: options.classification }),
  });
}
export function modelTool(
  binding: AgentProgramInput,
  options: { readonly resultClassification: DataClassification },
): ChatModelToolDeclaration {
  return Object.freeze({
    kind: "sweatpants.chat-model-tool.v1",
    binding,
    resultClassification: requireClassification(options.resultClassification),
  });
}

/** Explicit provenance envelope for tools that can refine their declared conservative ceiling. */
export function classifiedToolResult(
  value: Json,
  provenance: {
    readonly classifications: readonly DataClassification[];
    readonly sourceDigests?: readonly string[];
  },
): ClassifiedToolResultV1 {
  const classifications = sortedValues(
    new Set(provenance.classifications.map(requireClassification)),
    compareClassifications,
  );
  const sourceDigests = sortedValues(new Set(provenance.sourceDigests ?? []), (left, right) =>
    left.localeCompare(right),
  );
  if (sourceDigests.some((digest) => !/^[0-9a-f]{64}$/.test(digest))) {
    invalid("classified tool result contains an invalid source digest");
  }
  return Object.freeze({
    format: "sweatpants.classified-tool-result.v1",
    value: canonicalSnapshot(value).value,
    provenance: Object.freeze({
      classifications: Object.freeze(classifications),
      sourceDigests: Object.freeze(sourceDigests),
    }),
  });
}

export function toolScoped(
  resourcePackage: ResourcePackage,
  tools: readonly { readonly manifest: DurableProgramManifest }[],
): ChatResourceMountDeclaration {
  return Object.freeze({
    package: resourcePackage,
    access: Object.freeze({
      kind: "tool_scoped",
      tools: tools.map((tool) => ({
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
      })),
    }),
  });
}

export function defineChatProgram(options: DefineChatProgramOptions): ChatProgramDefinition {
  exactKeys(options, [
    "identity",
    "systemPrompt",
    "guidance",
    "resources",
    "tools",
    "effects",
    "elicitations",
    "contextPolicy",
    "maxIterations",
    "sampling",
    "schemaCatalog",
  ]);
  const programName = stableId(options.identity?.name, "program name");
  const version = boundedText(options.identity?.version, 128, "program version");
  const systemPrompt = normalizeSystemPrompt(options.systemPrompt);
  const contextPolicy = options.contextPolicy ?? latestContextWindow();
  // Rebuild to verify the supplied policy's complete digest and bounds.
  if (
    latestContextWindow({
      id: contextPolicy.id,
      version: contextPolicy.version,
      maxMessages: contextPolicy.maxMessages,
      maxReferencedTasks: contextPolicy.maxReferencedTasks,
      maxCanonicalBytes: contextPolicy.maxCanonicalBytes,
    }).digest !== contextPolicy.digest
  ) {
    invalid("context policy digest mismatch");
  }
  const maxIterations = options.maxIterations ?? 12;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) {
    invalid("maxIterations must be between 1 and 100");
  }
  const sampling = normalizeSampling(options.sampling ?? {});

  const registry = new ResourcePackageRegistry();
  const mounts: ResourceMount[] = [];
  for (const root of sortedKeys(options.resources ?? {})) {
    const declaration = options.resources![root]!;
    registry.install(declaration.package);
    mounts.push({ root, package: declaration.package, access: declaration.access });
  }
  const guidance = sortedValues(options.guidance ?? [], (a, b) => a.id.localeCompare(b.id));
  for (const item of guidance) {
    registry.install(item.package);
    const mounted = mounts.some(
      (mount) =>
        mount.package.manifest.digest === item.package.manifest.digest &&
        mount.access.kind === "model_readable",
    );
    if (!mounted) {
      invalid("guidance package must have an explicit model-readable mount");
    }
  }
  const resourceView = defineResourceView(mounts);
  const readers = generateResourceReaders({
    view: resourceView,
    registry,
    consumer: { kind: "model" },
  });

  const toolBindings: Record<string, AgentProgramBinding> = {};
  const toolResultClassifications: Record<string, DataClassification> = {};
  for (const alias of sortedKeys(options.tools ?? {})) {
    stableId(alias, "tool alias");
    if (alias.startsWith("resources.")) {
      invalid("resources.* tool aliases are reserved for deterministic resource readers");
    }
    const declaration = normalizeModelToolDeclaration(options.tools![alias]!);
    toolBindings[alias] = normalizeProgramBinding(declaration.binding);
    toolResultClassifications[alias] = declaration.resultClassification;
  }
  const childPrograms: Record<string, AgentProgramBinding> = {
    ...toolBindings,
    "resources.stat": readerBinding(readers.stat),
    "resources.list": readerBinding(readers.list),
    "resources.read": readerBinding(readers.read),
    "resources.search": readerBinding(readers.search),
  };
  const effects: Record<string, EffectDefinition<Json, Json, Json>> = {
    [CHAT_MODEL_SAMPLE_EFFECT.name]: CHAT_MODEL_SAMPLE_EFFECT as EffectDefinition<Json, Json, Json>,
  };
  for (const effectName of sortedKeys(options.effects ?? {})) {
    const definition = options.effects![effectName]!;
    validateEffectDefinition(definition);
    if (definition.name !== effectName) {
      invalid("effect key must equal symbolic name");
    }
    const existing = effects[effectName];
    if (existing && canonicalJson(existing) !== canonicalJson(definition)) {
      invalid("conflicting effect definition");
    }
    effects[effectName] = definition;
  }
  const authoredSchemas = Object.values(effects).flatMap((definition) =>
    definition === CHAT_MODEL_SAMPLE_EFFECT ? [] : [...effectCatalogEntries(definition)],
  );
  const effectSchemas = aggregateSchemas([...authoredSchemas, ...(options.schemaCatalog ?? [])]);
  if (Object.keys(options.elicitations ?? {}).length > 0) {
    invalid("authored chat v1 does not support model-triggered elicitations");
  }
  const elicitations = normalizeElicitations({});
  requireOperationSchemaCoverage(effects, elicitations, [
    ...CHAT_CONTRACT_SCHEMA_ENTRIES,
    ...MODEL_SAMPLE_SCHEMA_ENTRIES,
    ...effectSchemas,
  ]);
  const toolInventory = buildToolInventory(toolBindings, readers, resourceView.mounts.length > 0);
  const index = guidanceIndex(guidance);
  const resourcePackages = sortedValues(
    new Map(mounts.map((mount) => [mount.package.manifest.digest, mount.package])).values(),
    (a, b) => a.manifest.digest.localeCompare(b.manifest.digest),
  );
  const configuration = assertJson({
    engine: GENERIC_CHAT_ENGINE,
    systemPrompt,
    guidance: index,
    resourceView: resourceViewProjection(resourceView),
    readers: Object.fromEntries(
      Object.entries({
        stat: readers.stat,
        list: readers.list,
        read: readers.read,
        search: readers.search,
      }).map(([key, reader]) => [key, pin(reader)]),
    ),
    tools: Object.fromEntries(
      Object.entries(toolBindings).map(([key, binding]) => [
        key,
        {
          program: pin(binding.program),
          resultClassification: toolResultClassifications[key]!,
        },
      ]),
    ),
    effects,
    elicitations,
    contextPolicy,
    maxIterations,
    sampling,
  });
  const manifestWithoutDigest: Omit<
    DurableProgramManifest<ChatTurnInputV1 & Json, ChatTurnResultV1 & Json>,
    "digest"
  > = {
    programId: programName,
    version,
    inputSchema: CHAT_TURN_INPUT_DESCRIPTOR,
    outputSchema: CHAT_TURN_RESULT_DESCRIPTOR,
    elicits: elicitations,
    effects,
    capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
  };
  const implementationArtifactDigest = sha256(
    CHAT_PROGRAM_IDENTITY_DOMAIN + canonicalJson(configuration),
  );
  const artifact = generateProgramArtifactIdentity({
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
    manifest: manifestWithoutDigest,
    implementationArtifactDigest,
    resourcePackageDigests: resourcePackages.map((resource) => resource.manifest.digest),
  });
  const program = createGeneratedPinnedDurableProgram<
    ChatTurnInputV1 & Json,
    ChatTurnResultV1 & Json
  >(artifact, function* (input, context) {
    const accepted: ChatTurnInputV1 = input;
    const messages: ChatMessageV1[] = [];
    const seen = new Set<string>();
    for (const summary of accepted.context.referencedTasks) {
      appendMessage(messages, seen, summary.summary);
    }
    for (const message of accepted.context.messages) {
      appendMessage(messages, seen, message);
    }
    appendMessage(messages, seen, accepted.message);
    const promptPart: ChatContentPartV1 = {
      value: `${systemPrompt.text}\n\nAvailable guidance (load explicitly with resources.read):\n${canonicalJson(assertJson(index))}`,
      provenance: { classifications: [systemPrompt.classification], sourceDigests: [] },
    };
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const classifications = chatPayloadClassifications({ systemPrompt: promptPart, messages });
      const sampled = decodeAuthoredModelResult(
        yield* context.effect(
          CHAT_MODEL_SAMPLE_EFFECT,
          encodeAuthoredModelRequest({
            messages,
            systemPrompt: promptPart,
            tools: toolInventory,
            classifications,
            sampling,
          }),
          { audience: "model-runtime" },
        ),
      );
      const assistant = normalizeChatMessage(sampled.message);
      messages.push(assistant);
      if (sampled.calls.length === 0) {
        return normalizeChatTurnResult({
          format: CHAT_TURN_RESULT_FORMAT,
          message: assistant,
          artifacts: sampled.artifacts,
        }) as ChatTurnResultV1 & Json;
      }
      for (const call of sampled.calls) {
        const binding = childPrograms[call.target];
        if (!binding) {
          throw new CrankError("invalid_chat_program", "Model requested an undeclared tool");
        }
        const result = yield* context.invoke<Json>({ ...pin(binding.program), input: call.input });
        messages.push(
          toolResultMessage(
            call.id,
            call.target,
            result,
            call.target.startsWith("resources.")
              ? resourceResultProvenance(result)
              : declaredToolResultProvenance(
                  toolResultClassifications[call.target] ?? "restricted",
                  result,
                ),
          ),
        );
      }
    }
    throw new CrankError("max_tool_iterations", "Maximum authored chat iterations reached");
  });
  const schemaCatalog = aggregateSchemas([
    ...CHAT_CONTRACT_SCHEMA_ENTRIES,
    ...MODEL_SAMPLE_SCHEMA_ENTRIES,
    ...effectSchemas,
    ...Object.values(childPrograms).flatMap((binding) => binding.schemas),
  ]);
  return Object.freeze({
    ...program,
    kind: "sweatpants.chat-program.v1" as const,
    schemaCatalog: Object.freeze(schemaCatalog),
    resourcePackages: Object.freeze(resourcePackages),
    resourceView,
    resourceReaders: readers,
    resourceRegistry: registry,
    childPrograms: Object.freeze(childPrograms),
    toolResultClassifications: Object.freeze(toolResultClassifications),
    configuration,
    contextPolicy,
  }) satisfies ChatProgramDefinition;
}

/** Deployment binding that enforces exact-payload classification before provider invocation. */
export function createChatModelEffectRegistration(options: {
  readonly allowedClassifications: readonly DataClassification[];
  readonly sample: (
    request: ChatModelSampleInputV2,
    context: DurableEffectContext,
  ) => Operation<ChatModelSampleOutputV2>;
}): DurableEffectRegistration {
  const allowed = new Set(options.allowedClassifications);
  const inputSchema = MODEL_SAMPLE_SCHEMA_ENTRIES.find(
    (entry) => entry.descriptor.digest === CHAT_MODEL_SAMPLE_EFFECT.inputSchema.digest,
  )!;
  const outputSchema = MODEL_SAMPLE_SCHEMA_ENTRIES.find(
    (entry) => entry.descriptor.digest === CHAT_MODEL_SAMPLE_EFFECT.outputSchema.digest,
  )!;
  return createDurableEffectRegistration(
    CHAT_MODEL_SAMPLE_EFFECT,
    CHAT_MODEL_SAMPLE_EFFECT.retrySafety,
    function* (request, context): Operation<DurableEffectDisposition<ModelSampleResult>> {
      const authored = decodeAuthoredModelRequest(request);
      if (authored.classifications.some((classification) => !allowed.has(classification))) {
        throw new CrankError(
          "model_egress_forbidden",
          "Selected model route does not authorize the payload classification",
        );
      }
      const value = yield* options.sample(authored, context);
      return { status: "ok", value: encodeAuthoredModelResult(value) };
    },
    { input: inputSchema.schema, output: outputSchema.schema },
  );
}

function encodeAuthoredModelRequest(value: ChatModelSampleInputV2): ModelSampleRequest {
  return assertJson({
    messages: value.messages,
    systemPrompt: value.systemPrompt,
    tools: value.tools,
    classifications: value.classifications,
    sampling: value.sampling,
  }) as ModelSampleRequest;
}

function decodeAuthoredModelRequest(value: ModelSampleRequest): ChatModelSampleInputV2 {
  if (
    !Array.isArray(value.classifications) ||
    value.systemPrompt === undefined ||
    value.sampling === undefined
  ) {
    throw new CrankError("invalid_manifest", "Authored model sampling metadata is missing");
  }
  // The request crossed the durable effect boundary as Json; re-verify each
  // authored contract shape instead of trusting the wire.
  return {
    messages: value.messages.map((message) => normalizeChatMessage(message)),
    systemPrompt: normalizeContentPart(value.systemPrompt),
    tools: value.tools ?? [],
    classifications: value.classifications as DataClassification[],
    sampling: value.sampling,
  };
}

function encodeAuthoredModelResult(value: ChatModelSampleOutputV2): ModelSampleResult {
  const normalized = normalizeModelSampleOutput(value);
  return assertJson({
    text: normalized.message.parts
      .map((part) => (typeof part.value === "string" ? part.value : ""))
      .join(""),
    calls: normalized.calls,
    content: [normalized.message, ...normalized.artifacts],
  }) as ModelSampleResult;
}

function decodeAuthoredModelResult(value: ModelSampleResult): ChatModelSampleOutputV2 {
  // Direct authored form: { message, calls, artifacts }. Detect by shape and
  // let normalizeModelSampleOutput perform the actual validation.
  const record = value as Record<string, unknown>;
  if (record["message"] && Array.isArray(record["calls"]) && Array.isArray(record["artifacts"])) {
    return normalizeModelSampleOutput({
      message: record["message"],
      calls: record["calls"],
      artifacts: record["artifacts"],
    });
  }
  const [message, ...artifacts] = value.content;
  return normalizeModelSampleOutput({
    message,
    calls: value.calls,
    artifacts,
  });
}

function normalizeModelToolDeclaration(input: ChatModelToolDeclaration): ChatModelToolDeclaration {
  if (!input || typeof input !== "object" || input.kind !== "sweatpants.chat-model-tool.v1") {
    invalid("chat model tools must be declared with modelTool()");
  }
  exactKeys(input, ["kind", "binding", "resultClassification"]);
  return Object.freeze({
    kind: "sweatpants.chat-model-tool.v1",
    binding: input.binding,
    resultClassification: requireClassification(input.resultClassification),
  });
}
function normalizeProgramBinding(input: AgentProgramInput): AgentProgramBinding {
  const binding = isBinding(input) ? input : undefined;
  const program = binding?.program ?? (input as DurableTool);
  if (!program || program.durability !== "crank_native") {
    invalid("tool executable binding is missing");
  }
  const extended = program as DurableTool & {
    readonly schemaCatalog?: readonly SchemaBinding[];
    readonly artifacts?: { readonly catalog?: readonly SchemaBinding[] };
    readonly resourcePackages?: readonly ResourcePackage[];
    readonly resourceReaders?: ResourceReaderPrograms;
  };
  const schemas = [
    ...(binding?.schemas ?? extended.schemaCatalog ?? extended.artifacts?.catalog ?? []),
  ];
  if (schemas.length === 0) {
    invalid("tool schema bindings are missing");
  }
  return Object.freeze({
    program,
    schemas: Object.freeze(schemas),
    resources: Object.freeze([...(binding?.resources ?? extended.resourcePackages ?? [])]),
    ...((binding?.readers ?? extended.resourceReaders)
      ? { readers: binding?.readers ?? extended.resourceReaders }
      : {}),
  });
}
function readerBinding(program: ResourceReaderPrograms["read"]): AgentProgramBinding {
  return Object.freeze({ program, schemas: program.schemaCatalog, resources: Object.freeze([]) });
}
function isBinding(value: AgentProgramInput): value is AgentProgramBinding {
  return Boolean(
    value &&
    typeof value === "object" &&
    "program" in value &&
    typeof value.program === "object" &&
    value.program !== null &&
    "durability" in value.program,
  );
}
function normalizeSystemPrompt(value: ChatSystemPrompt): ChatSystemPrompt {
  exactKeys(value, ["text", "classification"]);
  if (!["public", "internal", "confidential", "restricted"].includes(value?.classification)) {
    invalid("system prompt classification is required");
  }
  return Object.freeze({
    text: boundedText(value?.text, 128 * 1024, "system prompt"),
    classification: value.classification,
  });
}
function normalizeSampling(value: ChatSamplingPolicyV1): Json {
  exactKeys(value, ["maxTokens", "toolChoice", "requirements"]);
  if (
    value.maxTokens !== undefined &&
    (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0)
  ) {
    invalid("invalid sampling maxTokens");
  }
  if (value.toolChoice !== undefined && !["auto", "none", "required"].includes(value.toolChoice)) {
    invalid("invalid sampling toolChoice");
  }
  const requirements = value.requirements
    ? sortedValues(new Set(value.requirements), (a, b) => a.localeCompare(b))
    : [];
  if (requirements.some((item) => typeof item !== "string" || item.length === 0)) {
    invalid("invalid sampling requirements");
  }
  return assertJson({
    ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
    ...(value.toolChoice ? { toolChoice: value.toolChoice } : {}),
    requirements,
  });
}
function normalizeElicitations(
  value: Readonly<
    Record<
      string,
      { readonly response: PortableSchemaDescriptor; readonly context?: PortableSchemaDescriptor }
    >
  >,
) {
  const result: Record<
    string,
    { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }
  > = {};
  for (const key of sortedKeys(value)) {
    stableId(key, "elicitation key");
    const item = value[key]!;
    result[key] = { response: item.response, ...(item.context ? { context: item.context } : {}) };
  }
  return Object.freeze(result);
}
function buildToolInventory(
  bindings: Record<string, AgentProgramBinding>,
  readers: ResourceReaderPrograms,
  includeResourceReaders: boolean,
): Json[] {
  const inventory: Json[] = Object.entries(bindings).map(([name, binding]) => ({
    name,
    description: `Durable program ${name}`,
    inputSchema: binding.program.manifest.inputSchema.inputProjection,
  }));
  if (includeResourceReaders) {
    for (const [name, reader] of Object.entries({
      "resources.stat": readers.stat,
      "resources.list": readers.list,
      "resources.read": readers.read,
      "resources.search": readers.search,
    })) {
      inventory.push({
        name,
        description: `Deterministic ${name}`,
        inputSchema: reader.manifest.inputSchema.inputProjection,
      });
    }
  }
  return sortedValues(inventory, (a, b) =>
    String((a as Record<string, Json>)["name"]).localeCompare(
      String((b as Record<string, Json>)["name"]),
    ),
  );
}
function resourceViewProjection(view: ResourceView): Json {
  return assertJson({
    format: view.format,
    digest: view.digest,
    limits: view.limits,
    mounts: view.mounts.map((mount) => ({
      root: mount.root,
      package: {
        id: mount.package.manifest.id,
        version: mount.package.manifest.version,
        digest: mount.package.manifest.digest,
      },
      access: mount.access,
    })),
  });
}
function toolResultMessage(
  callId: string,
  target: string,
  result: Json,
  provenance: ChatContentPartV1["provenance"],
): ChatMessageV1 {
  return normalizeChatMessage({
    id: `tool:${callId}`,
    role: "tool",
    parts: [{ value: { callId, target, result }, provenance }],
  });
}

/** Resource-reader output is trusted only because the exact generated reader schema validated it. */
function resourceResultProvenance(result: Json): ChatContentPartV1["provenance"] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new CrankError("invalid_chat_program", "Validated resource reader omitted provenance");
  }
  const classifications = Array.isArray(result["classifications"])
    ? result["classifications"].map(requireClassification)
    : [];
  const sources = Array.isArray(result["sources"]) ? result["sources"] : [];
  const sourceDigests = sources.flatMap((source) =>
    source && typeof source === "object" && !Array.isArray(source)
      ? [source["packageDigest"], source["fileDigest"]].filter(
          (item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/.test(item),
        )
      : [],
  );
  return {
    classifications: sortedValues(new Set(classifications), compareClassifications),
    sourceDigests: sortedValues(new Set(sourceDigests), (left, right) => left.localeCompare(right)),
  };
}

function declaredToolResultProvenance(
  declared: DataClassification,
  result: Json,
): ChatContentPartV1["provenance"] {
  const reported = parseClassifiedToolResult(result);
  const classifications = [declared, ...(reported?.classifications ?? [])];
  const ceiling = classifications.reduce((highest, candidate) =>
    classificationRank(candidate) > classificationRank(highest) ? candidate : highest,
  );
  return {
    classifications: [ceiling],
    sourceDigests: reported?.sourceDigests ?? [],
  };
}

function parseClassifiedToolResult(result: Json): ChatContentPartV1["provenance"] | undefined {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result["format"] !== "sweatpants.classified-tool-result.v1" ||
    !result["provenance"] ||
    typeof result["provenance"] !== "object" ||
    Array.isArray(result["provenance"])
  ) {
    return undefined;
  }
  const provenance = result["provenance"];
  if (
    !Array.isArray(provenance["classifications"]) ||
    !Array.isArray(provenance["sourceDigests"])
  ) {
    throw new CrankError("invalid_chat_program", "Classified tool result provenance is invalid");
  }
  const sourceDigests = provenance["sourceDigests"].map((digest) => {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new CrankError("invalid_chat_program", "Classified tool result digest is invalid");
    }
    return digest;
  });
  return {
    classifications: sortedValues(
      new Set(provenance["classifications"].map(requireClassification)),
      compareClassifications,
    ),
    sourceDigests: sortedValues(new Set(sourceDigests), (left, right) => left.localeCompare(right)),
  };
}
function appendMessage(messages: ChatMessageV1[], seen: Set<string>, value: ChatMessageV1): void {
  const message = normalizeChatMessage(value);
  if (!seen.has(message.id)) {
    seen.add(message.id);
    messages.push(message);
  }
}
function pin(tool: DurableTool) {
  return {
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
  };
}
function requireOperationSchemaCoverage(
  effects: Readonly<Record<string, EffectDefinition<Json, Json, Json>>>,
  elicitations: Readonly<
    Record<string, { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }>
  >,
  schemas: readonly SchemaBinding[],
): void {
  const installed = new Set(schemas.map((entry) => entry.descriptor.digest));
  const required = [
    ...Object.values(effects).flatMap((definition) => [
      definition.inputSchema,
      definition.outputSchema,
      ...(definition.cancellation ? [definition.cancellation.partialSchema] : []),
    ]),
    ...Object.values(elicitations).flatMap((declaration) => [
      declaration.response,
      ...(declaration.context ? [declaration.context] : []),
    ]),
  ];
  if (
    required.some(
      (descriptor) => descriptor.role !== "builtin" && !installed.has(descriptor.digest),
    )
  ) {
    invalid("effect or elicitation runtime schema binding is missing");
  }
}
function aggregateSchemas(entries: SchemaBinding[]): SchemaBinding[] {
  const map = new Map(entries.map((entry) => [entry.descriptor.digest, entry]));
  return sortedValues(map.values(), (a, b) =>
    a.descriptor.digest.localeCompare(b.descriptor.digest),
  );
}
function requireClassification(value: unknown): DataClassification {
  if (!(["public", "internal", "confidential", "restricted"] as const).includes(value as never)) {
    invalid("invalid data classification");
  }
  return value as DataClassification;
}
function classificationRank(value: DataClassification): number {
  return ["public", "internal", "confidential", "restricted"].indexOf(value);
}
function compareClassifications(left: DataClassification, right: DataClassification): number {
  return classificationRank(left) - classificationRank(right);
}
function sortedKeys(value: object): string[] {
  return sortedValues(Object.keys(value), (a, b) => a.localeCompare(b));
}
function exactKeys(value: unknown, allowed: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    invalid("unknown or invalid authoring field");
  }
}
function stableId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    invalid(`invalid ${field}`);
  }
  return value;
}
function boundedText(value: unknown, bytes: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > bytes
  ) {
    invalid(`invalid ${field}`);
  }
  return value;
}
function invalid(message: string): never {
  throw new CrankError("invalid_chat_program", message);
}
