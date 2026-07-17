import type { Operation } from "effection";
import {
  FOREIGN_MODEL_SAMPLE_EFFECT,
  canonicalSnapshot,
  createDurableEffectRegistration,
  createPinnedDurableProgram,
  createPortableSchemaDescriptor,
  defineDurableEffect,
  sha256,
  type DurableEffectContext,
  type DurableEffectDisposition,
  type DurableEffectRegistration,
  type DurableProgramContext,
  type DurableSchemaRegistryEntry,
  type Json,
  type ProgramResume,
  type ProgramStepProposal,
  type StandardSchemaV1,
} from "@sweatpants/session-contract";
import { REFERENCE_REVIEWER_ARTIFACT_DIGEST } from "./reviewer-artifact.generated.ts";

export { REFERENCE_REVIEWER_ARTIFACT_DIGEST } from "./reviewer-artifact.generated.ts";

export type AskParentInput = { question: string; rationale?: string };
export type AskParentOutput =
  | { status: "answered"; answer: string; source?: string }
  | { status: "unknown"; reason?: string }
  | { status: "declined"; reason?: string };
export type AskParentCancellationPartial = { reason?: string };
export type ConsultationContextRef = { contextId: string; digest: string };
export type ReviewInput = { design: string; rubric: string; instructions: string };
export type ReviewOutput = { review: Json };

const askInputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["question"], ["rationale"]))
    return "invalid ask_parent input";
  if (
    typeof value["question"] !== "string" ||
    value["question"].length < 1 ||
    value["question"].length > 8_192
  )
    return "invalid question";
  if (
    value["rationale"] !== undefined &&
    (typeof value["rationale"] !== "string" || value["rationale"].length > 8_192)
  )
    return "invalid rationale";
  return undefined;
});
const askOutputSchema = standardSchema((value) => validateAskOutput(value));
const askPartialSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, [], ["reason"])) return "invalid cancellation partial";
  if (value["reason"] !== undefined && typeof value["reason"] !== "string")
    return "invalid cancellation reason";
  return undefined;
});
const reviewInputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["design", "rubric", "instructions"], []))
    return "invalid review input";
  if (
    [value["design"], value["rubric"], value["instructions"]].some(
      (field) => typeof field !== "string" || field.length === 0,
    )
  )
    return "review input fields must be nonempty strings";
  return undefined;
});
const reviewOutputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["review"], [])) return "invalid review output";
  try {
    canonicalSnapshot(value["review"]);
  } catch {
    return "review must be canonical JSON";
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
const REVIEW_INPUT_DESCRIPTOR = descriptor("reference-review/reviewer-input", "program_input", {
  type: "object",
  properties: {
    design: { type: "string" },
    rubric: { type: "string" },
    instructions: { type: "string" },
  },
  required: ["design", "rubric", "instructions"],
  additionalProperties: false,
});
const REVIEW_OUTPUT_DESCRIPTOR = descriptor("reference-review/reviewer-output", "program_output", {
  type: "object",
  properties: { review: {} },
  required: ["review"],
  additionalProperties: false,
});

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
  if (!Number.isSafeInteger(options.policy.questionBudget) || options.policy.questionBudget < 0)
    throw new Error("questionBudget must be a nonnegative integer");
  return createDurableEffectRegistration(
    ASK_PARENT_EFFECT,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* (
      input: AskParentInput,
      effect: DurableEffectContext,
    ): Operation<DurableEffectDisposition<AskParentOutput, AskParentCancellationPartial>> {
      const recorded = yield* options.store.outcome(effect.pullId);
      if (recorded) return { status: "ok", value: recorded };
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
        if (duplicate) return { status: "ok", value: duplicate };
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
      if (validateAskOutput(outcome))
        throw new Error("consultation provider returned an invalid outcome");
      return { status: "ok", value: yield* options.store.commit(effect.pullId, outcome) };
    },
    { input: askInputSchema, output: askOutputSchema },
  );
}

/**
 * Clean-context reviewer. Its first model request receives only explicit design,
 * rubric, and instructions. Parent information appears only after ask_parent's
 * recorded effect outcome.
 */
export const REFERENCE_REVIEWER_TOOL = createPinnedDurableProgram(
  {
    programId: "reference.clean-context-reviewer",
    version: "1.0.0",
    digest: REFERENCE_REVIEWER_ARTIFACT_DIGEST,
    inputSchema: REVIEW_INPUT_DESCRIPTOR,
    outputSchema: REVIEW_OUTPUT_DESCRIPTOR,
    elicits: {},
    effects: {
      [FOREIGN_MODEL_SAMPLE_EFFECT.name]: FOREIGN_MODEL_SAMPLE_EFFECT,
      [ASK_PARENT_EFFECT.name]: ASK_PARENT_EFFECT,
    },
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
  },
  function* (input: ReviewInput, context) {
    return yield* reviewerGenerator(input, context);
  },
);

function* reviewerGenerator(
  input: ReviewInput,
  context: DurableProgramContext,
): Generator<ProgramStepProposal, ReviewOutput, ProgramResume> {
  const questionSample = yield* context.effect(
    FOREIGN_MODEL_SAMPLE_EFFECT,
    {
      messages: [
        { role: "system", content: input.instructions },
        { role: "user", content: `Rubric:\n${input.rubric}\n\nDesign:\n${input.design}` },
      ],
      task: "Return one narrow factual question for the design author as {question, rationale?}.",
    },
    { audience: "caller:model" },
  );
  const question = extractQuestion(questionSample);
  const answer = yield* context.effect(ASK_PARENT_EFFECT, question, {
    audience: "caller:reference-review",
  });
  const review = yield* context.effect(
    FOREIGN_MODEL_SAMPLE_EFFECT,
    {
      messages: [
        { role: "system", content: input.instructions },
        { role: "user", content: `Rubric:\n${input.rubric}\n\nDesign:\n${input.design}` },
        { role: "assistant", content: `Question: ${question.question}` },
        { role: "tool", name: "ask_parent", content: canonicalSnapshot(answer).canonical },
      ],
      task: "Return an independent review. Use only the supplied design and narrow recorded answer.",
    },
    { audience: "caller:model" },
  );
  return { review };
}

export const REFERENCE_REVIEW_SCHEMA_ENTRIES: readonly DurableSchemaRegistryEntry[] = Object.freeze(
  [
    { descriptor: ASK_INPUT_DESCRIPTOR, schema: askInputSchema },
    { descriptor: ASK_OUTPUT_DESCRIPTOR, schema: askOutputSchema },
    { descriptor: ASK_PARTIAL_DESCRIPTOR, schema: askPartialSchema },
    { descriptor: REVIEW_INPUT_DESCRIPTOR, schema: reviewInputSchema },
    { descriptor: REVIEW_OUTPUT_DESCRIPTOR, schema: reviewOutputSchema },
  ],
);

function extractQuestion(value: Json): AskParentInput {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const question = value["question"];
    const rationale = value["rationale"];
    if (typeof question === "string" && question.length > 0) {
      return {
        question,
        ...(typeof rationale === "string" ? { rationale } : {}),
      };
    }
  }
  return { question: "Which explicit design constraint most influenced this choice?" };
}

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
  if (!record(value) || typeof value["status"] !== "string") return "invalid ask_parent output";
  if (value["status"] === "answered") {
    if (!onlyKeys(value, ["status", "answer"], ["source"]) || typeof value["answer"] !== "string")
      return "invalid answered outcome";
    if (value["source"] !== undefined && typeof value["source"] !== "string")
      return "invalid answer source";
    return;
  }
  if (value["status"] === "unknown" || value["status"] === "declined") {
    if (!onlyKeys(value, ["status"], ["reason"])) return "invalid non-answer outcome";
    if (value["reason"] !== undefined && typeof value["reason"] !== "string")
      return "invalid non-answer reason";
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
