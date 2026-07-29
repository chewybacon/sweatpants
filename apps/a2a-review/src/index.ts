import { defineDurableEffect } from "@sweatpants/durable-effects/authoring";
import {
  type DurableEffectContext,
  type DurableEffectDisposition,
  type DurableEffectRegistration,
} from "@sweatpants/durable-effects";

import type { Operation } from "effection";
import {
  advertiseCapability,
  defineAgent,
  defineGuidance,
  defineResourcePackage,
  textResource,
} from "@sweatpants/agent-sdk";
import {
  CHAT_MODEL_SAMPLE_EFFECT,
  acceptChatTurn,
  defineChatProgram,
  modelReadable,
  modelTool,
  type ChatMessageV1,
  type ChatTurnInputV1,
} from "@sweatpants/chat-core";
import { remoteExecutor, serveAgent } from "@sweatpants/agent-host/server";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  generateProgramArtifactIdentity,
} from "@sweatpants/durable-execution";
import { sha256, type Json } from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import { defineReviewerProgram, type ReviewInput } from "./reviewer-program.ts";
import { REFERENCE_REVIEWER_ARTIFACT_DIGEST } from "./reviewer-artifact.generated.ts";

export { REFERENCE_REVIEWER_ARTIFACT_DIGEST } from "./reviewer-artifact.generated.ts";
export { CHAT_MODEL_SAMPLE_EFFECT };

export type AskParentInput = { question: string; rationale?: string };
export type AskParentOutput =
  | { status: "answered"; answer: string; source?: string }
  | { status: "unknown"; reason?: string }
  | { status: "declined"; reason?: string };
export type AskParentCancellationPartial = { reason?: string };
export type ConsultationContextRef = { contextId: string; digest: string };
export type { ReviewInput, ReviewOutput } from "./reviewer-program.ts";

const askInputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["question"], ["rationale"])) {
    return "invalid ask_parent input";
  }
  if (
    typeof value["question"] !== "string" ||
    value["question"].length < 1 ||
    value["question"].length > 8_192
  ) {
    return "invalid question";
  }
  if (
    value["rationale"] !== undefined &&
    (typeof value["rationale"] !== "string" || value["rationale"].length > 8_192)
  ) {
    return "invalid rationale";
  }
  return undefined;
});
const askOutputSchema = standardSchema((value) => validateAskOutput(value));
const askPartialSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, [], ["reason"])) {
    return "invalid cancellation partial";
  }
  if (value["reason"] !== undefined && typeof value["reason"] !== "string") {
    return "invalid cancellation reason";
  }
  return undefined;
});
const ASK_INPUT_DESCRIPTOR = descriptor("reference-review/ask-parent-input", "effect_input", {
  type: "object",
  properties: { question: { type: "string" }, rationale: { type: "string" } },
  required: ["question"],
  additionalProperties: false,
});
const ASK_OUTPUT_DESCRIPTOR = descriptor("reference-review/ask-parent-output", "effect_output", {
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "answered" },
        answer: { type: "string" },
        source: { type: "string" },
      },
      required: ["status", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { status: { enum: ["unknown", "declined"] }, reason: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
  ],
});
const ASK_PARTIAL_DESCRIPTOR = descriptor(
  "reference-review/ask-parent-partial",
  "effect_cancellation_partial",
  {
    type: "object",
    properties: { reason: { type: "string" } },
    additionalProperties: false,
  },
);
const ASK_PROGRAM_INPUT_DESCRIPTOR = descriptor(
  "reference-review/ask-parent-program-input",
  "program_input",
  ASK_INPUT_DESCRIPTOR.inputProjection,
);
const ASK_PROGRAM_OUTPUT_DESCRIPTOR = descriptor(
  "reference-review/ask-parent-program-output",
  "program_output",
  ASK_OUTPUT_DESCRIPTOR.outputProjection,
);
/** Application-owned consultation contract; this name and shape are not A2A protocol data. */
export const ASK_PARENT_EFFECT = defineDurableEffect<
  AskParentInput,
  AskParentOutput,
  AskParentCancellationPartial
>({
  name: "reference.review.ask_parent",
  version: "1.0.0",
  inputSchema: ASK_INPUT_DESCRIPTOR,
  outputSchema: ASK_OUTPUT_DESCRIPTOR,
  cancellation: { partialSchema: ASK_PARTIAL_DESCRIPTOR },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export interface ConsultationPolicy {
  readonly questionBudget: number;
  readonly allowUserEscalation: boolean;
  readonly allowQuestion: (input: AskParentInput) => boolean;
}

/** Durable application state. Implementations MUST make claim/commit atomic and persistent. */
export interface ConsultationStore {
  context(ref: ConsultationContextRef): Operation<{ content: string; source?: string } | undefined>;
  claimQuestion(pullId: string, budget: number): Operation<"allowed" | "duplicate" | "exhausted">;
  outcome(pullId: string): Operation<AskParentOutput | undefined>;
  commit(pullId: string, outcome: AskParentOutput): Operation<AskParentOutput>;
}

export interface ConsultationAnswerProvider {
  answer(request: {
    idempotencyKey: string;
    question: string;
    rationale?: string;
    context: string;
    source?: string;
    cancellation: AbortSignal;
  }): Operation<AskParentOutput>;
  elicit?(request: {
    idempotencyKey: string;
    question: string;
    cancellation: AbortSignal;
  }): Operation<
    { action: "accept"; answer: string } | { action: "decline" | "cancel"; reason?: string }
  >;
}

export function createAskParentRegistration(options: {
  context: ConsultationContextRef;
  policy: ConsultationPolicy;
  store: ConsultationStore;
  provider: ConsultationAnswerProvider;
}): DurableEffectRegistration {
  if (!Number.isSafeInteger(options.policy.questionBudget) || options.policy.questionBudget < 0) {
    throw new Error("questionBudget must be a nonnegative integer");
  }
  return createDurableEffectRegistration(
    ASK_PARENT_EFFECT,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* (
      input: AskParentInput,
      effect: DurableEffectContext,
    ): Operation<DurableEffectDisposition<AskParentOutput, AskParentCancellationPartial>> {
      const recorded = yield* options.store.outcome(effect.pullId);
      if (recorded) {
        return { status: "ok", value: recorded };
      }
      if (!options.policy.allowQuestion(input)) {
        return {
          status: "ok",
          value: yield* options.store.commit(effect.pullId, {
            status: "declined",
            reason: "consultation policy denied the question",
          }),
        };
      }
      const claim = yield* options.store.claimQuestion(
        effect.pullId,
        options.policy.questionBudget,
      );
      if (claim === "duplicate") {
        const duplicate = yield* options.store.outcome(effect.pullId);
        if (duplicate) {
          return { status: "ok", value: duplicate };
        }
      }
      if (claim === "exhausted") {
        return {
          status: "ok",
          value: yield* options.store.commit(effect.pullId, {
            status: "unknown",
            reason: "consultation question budget exhausted",
          }),
        };
      }
      const selected = yield* options.store.context(options.context);
      let outcome: AskParentOutput;
      if (selected) {
        if (sha256(selected.content) !== options.context.digest) {
          outcome = { status: "unknown", reason: "pinned consultation context is unavailable" };
        } else {
          outcome = yield* options.provider.answer({
            idempotencyKey: effect.pullId,
            question: input.question,
            ...(input.rationale ? { rationale: input.rationale } : {}),
            context: selected.content,
            ...(selected.source ? { source: selected.source } : {}),
            cancellation: effect.cancellation,
          });
        }
      } else if (options.policy.allowUserEscalation && options.provider.elicit) {
        const response = yield* options.provider.elicit({
          idempotencyKey: effect.pullId,
          question: input.question,
          cancellation: effect.cancellation,
        });
        outcome =
          response.action === "accept"
            ? { status: "answered", answer: response.answer, source: "user" }
            : { status: "declined", ...(response.reason ? { reason: response.reason } : {}) };
      } else {
        outcome = { status: "unknown", reason: "pinned consultation context is unavailable" };
      }
      if (validateAskOutput(outcome)) {
        throw new Error("consultation provider returned an invalid outcome");
      }
      return { status: "ok", value: yield* options.store.commit(effect.pullId, outcome) };
    },
    { input: askInputSchema, output: askOutputSchema },
  );
}

export const REFERENCE_ASK_PARENT_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  { descriptor: ASK_PROGRAM_INPUT_DESCRIPTOR, schema: askInputSchema },
  { descriptor: ASK_PROGRAM_OUTPUT_DESCRIPTOR, schema: askOutputSchema },
  { descriptor: ASK_INPUT_DESCRIPTOR, schema: askInputSchema },
  { descriptor: ASK_OUTPUT_DESCRIPTOR, schema: askOutputSchema },
  { descriptor: ASK_PARTIAL_DESCRIPTOR, schema: askPartialSchema },
]);

const askParentProgramManifest = {
  programId: "reference.review.ask-parent-tool",
  version: "1.0.0",
  inputSchema: ASK_PROGRAM_INPUT_DESCRIPTOR,
  outputSchema: ASK_PROGRAM_OUTPUT_DESCRIPTOR,
  elicits: {},
  effects: { [ASK_PARENT_EFFECT.name]: ASK_PARENT_EFFECT },
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" as const },
};
const askParentProgramIdentity = generateProgramArtifactIdentity({
  format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
  manifest: askParentProgramManifest,
  // Intentionally coarse for this acceptance app: one digest covers the
  // complete reviewer source set, so unrelated reviewer edits repin this child.
  implementationArtifactDigest: REFERENCE_REVIEWER_ARTIFACT_DIGEST,
  resourcePackageDigests: [],
});
export const REFERENCE_ASK_PARENT_TOOL = createGeneratedPinnedDurableProgram(
  askParentProgramIdentity,
  function* (input: AskParentInput, context) {
    return yield* context.effect(ASK_PARENT_EFFECT, input, {
      audience: "caller:reference-review",
    });
  },
);

const reviewerProgram = defineReviewerProgram({
  artifactDigest: REFERENCE_REVIEWER_ARTIFACT_DIGEST,
  askParentEffect: ASK_PARENT_EFFECT,
  askParentSchemas: REFERENCE_ASK_PARENT_SCHEMA_ENTRIES,
});
export const REFERENCE_REVIEWER_TOOL = reviewerProgram.tool;
export const REFERENCE_REVIEW_SCHEMA_ENTRIES = reviewerProgram.schemaEntries;

/**
 * Product-facade definition used by the caller-authoritative acceptance vertical.
 * Guidance is pinned and advisory; certification executes this generated chat
 * program and its exact ask_parent child with caller-owned effects.
 */
export const REFERENCE_REVIEWER_RESOURCES = defineResourcePackage({
  id: "reference-reviewer-guidance",
  version: "1.0.0",
  files: {
    "SKILL.md": textResource(
      "Review only the supplied design and rubric. Ask one narrow factual question through ask_parent before finalizing the review.",
    ),
  },
});
export const REFERENCE_REVIEWER_GUIDANCE = defineGuidance({
  id: "technical-review",
  summary: "Use when reviewing technical designs for authority and recovery risks.",
  package: REFERENCE_REVIEWER_RESOURCES,
  entryPath: "SKILL.md",
});
export const REFERENCE_REVIEWER_CHAT = defineChatProgram({
  identity: { name: "reference.reviewer.chat", version: "1.0.0" },
  systemPrompt: {
    text: "You are an independent technical design reviewer operating in a clean context.",
    classification: "internal",
  },
  guidance: [REFERENCE_REVIEWER_GUIDANCE],
  resources: {
    reviewing: modelReadable(REFERENCE_REVIEWER_RESOURCES, { classification: "internal" }),
  },
  tools: {
    ask_parent: modelTool(
      {
        program: REFERENCE_ASK_PARENT_TOOL,
        schemas: REFERENCE_ASK_PARENT_SCHEMA_ENTRIES,
        resources: [],
      },
      { resultClassification: "internal" },
    ),
  },
  maxIterations: 12,
});

export function createReviewChatInput(
  input: ReviewInput,
  frontier = "reference-review/accepted-frontier",
): ChatTurnInputV1 {
  const message: ChatMessageV1 = {
    id: "reference-review/current-design",
    role: "user",
    parts: [
      {
        value: input,
        provenance: { classifications: ["internal"], sourceDigests: [] },
      },
    ],
  };
  return acceptChatTurn(REFERENCE_REVIEWER_CHAT.contextPolicy, message, { frontier });
}

export const REFERENCE_REVIEWER_AGENT = defineAgent({
  identity: { name: "reference-reviewer", version: "1.0.0" },
  description: "Reviews technical designs in an isolated caller-authoritative context.",
  conversation: REFERENCE_REVIEWER_CHAT,
  programs: { review: REFERENCE_REVIEWER_CHAT },
  advertisedCapabilities: {
    technicalReview: advertiseCapability({
      id: "technicalReview",
      name: "Technical design review",
      description: "Reviews RFCs and architecture proposals.",
      tags: ["architecture", "review"],
      examples: ["Review this design for authority-boundary risks"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json", "text/plain"],
      authorization: "review-designs",
    }),
  },
});
export const REFERENCE_REVIEWER_REMOTE = serveAgent(
  REFERENCE_REVIEWER_AGENT,
  remoteExecutor({
    deployment: {
      interfaceUrl: "https://127.0.0.1/reference-reviewer/a2a",
      manifestEndpoint: "https://127.0.0.1/reference-reviewer/manifests",
      driverEndpoint: "wss://127.0.0.1/reference-reviewer/driver",
    },
    bindings: { technicalReview: "review" },
  }),
);

function standardSchema(validateValue: (value: unknown) => string | undefined): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "reference-review",
      validate(value: unknown) {
        const issue = validateValue(value);
        return issue ? { issues: [{ message: issue }] } : { value };
      },
    },
  };
}

function validateAskOutput(value: unknown): string | undefined {
  if (!record(value) || typeof value["status"] !== "string") {
    return "invalid ask_parent output";
  }
  if (value["status"] === "answered") {
    if (!onlyKeys(value, ["status", "answer"], ["source"]) || typeof value["answer"] !== "string") {
      return "invalid answered outcome";
    }
    if (value["source"] !== undefined && typeof value["source"] !== "string") {
      return "invalid answer source";
    }
    return;
  }
  if (value["status"] === "unknown" || value["status"] === "declined") {
    if (!onlyKeys(value, ["status"], ["reason"])) {
      return "invalid non-answer outcome";
    }
    if (value["reason"] !== undefined && typeof value["reason"] !== "string") {
      return "invalid non-answer reason";
    }
    return;
  }
  return "unknown ask_parent status";
}

function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function onlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function descriptor(
  identity: string,
  role: Parameters<typeof createPortableSchemaDescriptor>[0]["role"],
  projection: Json,
) {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1.0.0",
    vendor: "reference-review",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
}
