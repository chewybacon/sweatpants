import {
  FOREIGN_MODEL_SAMPLE_EFFECT,
  canonicalSnapshot,
  createPinnedDurableProgram,
  createPortableSchemaDescriptor,
  foreignToolSchemaEntries,
  type DurableProgramContext,
  type DurableSchemaRegistryEntry,
  type EffectDefinition,
  type Json,
  type StandardSchemaV1,
} from "@sweatpants/session-contract";

export type ReviewInput = { design: string; rubric: string; instructions: string };
export type ReviewOutput = { review: Json };
type AskParentInput = { question: string; rationale?: string };

const reviewInputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["design", "rubric", "instructions"], [])) {
    return "invalid review input";
  }
  if (
    [value["design"], value["rubric"], value["instructions"]].some(
      (field) => typeof field !== "string" || field.length === 0,
    )
  ) {
    return "review input fields must be nonempty strings";
  }
  return undefined;
});
const reviewOutputSchema = standardSchema((value) => {
  if (!record(value) || !onlyKeys(value, ["review"], [])) {
    return "invalid review output";
  }
  try {
    canonicalSnapshot(value["review"]);
  } catch {
    return "review must be canonical JSON";
  }
  return undefined;
});
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

/** Builds the low-level pinned reviewer used for driver conformance evidence. */
export function defineReviewerProgram(options: {
  readonly artifactDigest: string;
  readonly askParentEffect: EffectDefinition<Json, Json, Json>;
  readonly askParentSchemas: readonly DurableSchemaRegistryEntry[];
}) {
  const tool = createPinnedDurableProgram(
    {
      programId: "reference.clean-context-reviewer",
      version: "1.0.0",
      digest: options.artifactDigest,
      inputSchema: REVIEW_INPUT_DESCRIPTOR,
      outputSchema: REVIEW_OUTPUT_DESCRIPTOR,
      elicits: {},
      effects: {
        [FOREIGN_MODEL_SAMPLE_EFFECT.name]: FOREIGN_MODEL_SAMPLE_EFFECT,
        [options.askParentEffect.name]: options.askParentEffect,
      },
      capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
    },
    function* (input: ReviewInput, context) {
      return yield* reviewerGenerator(input, context, options.askParentEffect);
    },
  );
  const schemaEntries: readonly DurableSchemaRegistryEntry[] = Object.freeze([
    ...foreignToolSchemaEntries(),
    ...options.askParentSchemas,
    { descriptor: REVIEW_INPUT_DESCRIPTOR, schema: reviewInputSchema },
    { descriptor: REVIEW_OUTPUT_DESCRIPTOR, schema: reviewOutputSchema },
  ]);
  return Object.freeze({ tool, schemaEntries });
}

function* reviewerGenerator(
  input: ReviewInput,
  context: DurableProgramContext,
  askParentEffect: EffectDefinition<Json, Json, Json>,
) {
  const questionSample = yield* context.effect(
    FOREIGN_MODEL_SAMPLE_EFFECT,
    {
      messages: [
        {
          role: "system",
          content: `${input.instructions}\n\nReturn one narrow factual question for the design author as {question, rationale?}.`,
        },
        { role: "user", content: `Rubric:\n${input.rubric}\n\nDesign:\n${input.design}` },
      ],
    },
    { audience: "caller:model" },
  );
  const question = extractQuestion(questionSample);
  const answer = yield* context.effect(askParentEffect, question, {
    audience: "caller:reference-review",
  });
  const review = yield* context.effect(
    FOREIGN_MODEL_SAMPLE_EFFECT,
    {
      messages: [
        {
          role: "system",
          content: `${input.instructions}\n\nReturn an independent review. Use only the supplied design and narrow recorded answer.`,
        },
        { role: "user", content: `Rubric:\n${input.rubric}\n\nDesign:\n${input.design}` },
        { role: "assistant", content: `Question: ${question.question}` },
        { role: "tool", name: "ask_parent", content: canonicalSnapshot(answer).canonical },
      ],
    },
    { audience: "caller:model" },
  );
  return { review };
}

function extractQuestion(value: Json): AskParentInput {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const question = value["question"];
    const rationale = value["rationale"];
    if (typeof question === "string" && question.length > 0) {
      return { question, ...(typeof rationale === "string" ? { rationale } : {}) };
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
