import {
  MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_SCHEMA_ENTRIES,
  type ModelContextSource,
} from "@sweatpants/model-sampling";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { defineDurableProgramManifest } from "@sweatpants/durable-execution";
import { sha256, type JsonObject, canonicalDigest } from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { z } from "zod";

export type ChatToolCatalogEntry = {
  model: ChatToolDefinition;
  execution: z.infer<typeof catalogExecutionSchema>;
};

export type EphemeralToolCatalogExecution = Exclude<
  ChatToolCatalogEntry["execution"],
  { kind: "program" }
>;

export function isEphemeralToolCatalogExecution(
  execution: ChatToolCatalogEntry["execution"],
): execution is EphemeralToolCatalogExecution {
  return execution.kind === "ephemeral-tool";
}

/** Atomic model exposure plus execution target artifact accepted by chat-root. */
export type ChatToolCatalog = {
  version: 1;
  digest: string;
  entries: Record<string, ChatToolCatalogEntry>;
};

export type ChatProgramInput = {
  contextSource: ModelContextSource;
  systemPrompt?: string;
  toolChoice?: "auto" | "none" | "required";
  maxIterations: number | null;
  catalog: ChatToolCatalog;
} & JsonObject;

const chatEngineSchemaEntries: SchemaBinding[] = [];
const schemaText = z.string().min(1).max(4_096);
const catalogExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("program"),
    target: schemaText,
    program: z.strictObject({
      id: schemaText,
      version: schemaText,
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  }),
  z.strictObject({
    kind: z.literal("ephemeral-tool"),
    target: schemaText,
    driver: z.enum(["tool-session", "chat-tool-runtime"]),
    tool: schemaText,
    durability: z.literal("ephemeral_handle"),
  }),
]);
const chatToolCatalogEntrySchema = z.strictObject({
  model: z.strictObject({
    name: schemaText,
    description: z
      .string()
      .max(64 * 1024)
      .optional(),
    parameters: z.record(z.string(), z.json()),
  }),
  execution: catalogExecutionSchema,
});
const chatProgramInputSchema = z.strictObject({
  contextSource: z.strictObject({
    type: z.literal("conversation"),
    conversationId: schemaText,
    checkpoint: z.strictObject({ checkpointId: schemaText }),
    acceptedCommandId: schemaText,
    executionId: schemaText,
    taskId: schemaText,
    taskJournalFrontier: schemaText,
    systemPrompt: z
      .string()
      .max(64 * 1024)
      .optional(),
    contextArtifact: z.strictObject({ objectId: schemaText }).optional(),
  }),
  systemPrompt: z
    .string()
    .max(64 * 1024)
    .optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  maxIterations: z.number().int().min(1).max(100).nullable(),
  catalog: z.strictObject({
    version: z.literal(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    entries: z.record(schemaText, chatToolCatalogEntrySchema),
  }),
});

function chatEngineSchema<T extends z.ZodType>(
  identity: string,
  role: string,
  schema: T,
  validate?: (value: z.output<T>) => string | undefined,
): PortableSchemaDescriptor {
  const projection = z.toJSONSchema(schema) as JsonObject;
  const descriptor = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    // The generated shape is exact; the catalog digest remains a runtime invariant.
    fidelity: { input: "explicit", output: "explicit" },
  });
  chatEngineSchemaEntries.push({
    descriptor,
    schema: standardSchemaOf("sweatpants", (value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return { issues: parsed.error.issues };
      }
      const message = validate?.(parsed.data);
      return message === undefined ? { value: parsed.data } : { issues: [{ message }] };
    }),
  });
  return descriptor;
}

const chatRootInputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/input",
  "program_input",
  chatProgramInputSchema,
  ({ catalog }) =>
    catalog.digest === canonicalDigest({ version: 1, entries: catalog.entries })
      ? undefined
      : "catalog digest differs from entries",
);

const chatRootOutputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/output",
  "program_output",
  z.string(),
);

export const manifest = defineDurableProgramManifest<ChatProgramInput, string>({
  programId: "sweatpants.chat-root",
  version: "1.6.0",
  digest: sha256("sweatpants.chat-root@1.6.0:optional-outer-iteration-limit"),
  inputSchema: chatRootInputDescriptor,
  outputSchema: chatRootOutputDescriptor,
  elicits: {},
  effects: {},
  pulls: {
    sample: {
      input: MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
      output: MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
    },
  },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
});

/**
 * Digest-keyed validator entries for the built-in chat-root program and its
 * model-sampling pull. Deployments merge these with their generated tool
 * catalogs into the journal authority's schema registry.
 */
export function programDriverChatEngineSchemaEntries(): readonly SchemaBinding[] {
  return [...MODEL_SAMPLE_PULL_SCHEMA_ENTRIES, ...chatEngineSchemaEntries];
}
