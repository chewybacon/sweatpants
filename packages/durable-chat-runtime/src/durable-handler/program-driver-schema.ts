import {
  MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_SCHEMA_ENTRIES,
  type ModelContextSource,
} from "@sweatpants/model-sampling";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { defineDurableProgramManifest } from "@sweatpants/durable-execution";
import {
  assertJson,
  requireJsonObject,
  sha256,
  type Json,
  type JsonObject,
  canonicalDigest,
} from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type { NativeProgramIdentity as NativeIdentity } from "../program-driver/native-tools.ts";
import { z } from "zod";

export type ChatToolCatalogEntry = {
  model: ChatToolDefinition;
  execution:
    | { kind: "program"; target: string; program: NativeIdentity }
    | {
        kind: "ephemeral-tool";
        target: string;
        driver: "tool-session" | "chat-tool-runtime";
        tool: string;
        durability: "ephemeral_handle";
      };
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
  maxIterations: number;
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
  maxIterations: z.number().int().min(1).max(100),
  catalog: z.strictObject({
    version: z.literal(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    entries: z.record(schemaText, chatToolCatalogEntrySchema),
  }),
});

function chatEngineSchema(
  identity: string,
  role: string,
  projection: Json,
  guard: (value: unknown) => string | undefined,
  decode: (value: unknown) => Json = (value) => assertJson(value),
): PortableSchemaDescriptor {
  const descriptor = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
  chatEngineSchemaEntries.push({
    descriptor,
    schema: standardSchemaOf("sweatpants", (value) => {
      try {
        const decoded = decode(value);
        const message = guard(decoded);
        if (message !== undefined) {
          return { issues: [{ message }] };
        }
        return { value: decoded };
      } catch {
        return { issues: [{ message: "value could not be decoded" }] };
      }
    }),
  });
  return descriptor;
}

const chatRootInputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/input",
  "program_input",
  {
    type: "object",
    required: ["contextSource", "maxIterations", "catalog"],
    properties: {
      contextSource: {
        type: "object",
        required: [
          "type",
          "conversationId",
          "checkpoint",
          "acceptedCommandId",
          "executionId",
          "taskId",
          "taskJournalFrontier",
        ],
        properties: {
          type: { const: "conversation" },
          conversationId: { type: "string" },
          checkpoint: { type: "object" },
          acceptedCommandId: { type: "string" },
          executionId: { type: "string" },
          taskId: { type: "string" },
          taskJournalFrontier: { type: "string" },
          systemPrompt: { type: "string" },
          contextArtifact: { type: "object" },
        },
        additionalProperties: false,
      },
      systemPrompt: { type: "string" },
      toolChoice: { enum: ["auto", "none", "required"] },
      maxIterations: { type: "integer", minimum: 1, maximum: 100 },
      catalog: {
        type: "object",
        required: ["version", "digest", "entries"],
        properties: {
          version: { const: 1 },
          digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          entries: {
            type: "object",
            additionalProperties: {
              type: "object",
              required: ["model", "execution"],
              properties: {
                model: {
                  type: "object",
                  required: ["name", "parameters"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    parameters: { type: "object", additionalProperties: true },
                  },
                  additionalProperties: false,
                },
                execution: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["kind", "target", "program"],
                      properties: {
                        kind: { const: "program" },
                        target: { type: "string" },
                        program: { type: "object" },
                      },
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      required: ["kind", "target", "driver", "tool", "durability"],
                      properties: {
                        kind: { const: "ephemeral-tool" },
                        target: { type: "string" },
                        driver: { enum: ["tool-session", "chat-tool-runtime"] },
                        tool: { type: "string" },
                        durability: { const: "ephemeral_handle" },
                      },
                      additionalProperties: false,
                    },
                  ],
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  (value) => {
    const parsed = chatProgramInputSchema.safeParse(value);
    if (!parsed.success) {
      return "chat program input structure is invalid";
    }
    if (
      parsed.data.catalog.digest !==
      canonicalDigest({ version: 1, entries: parsed.data.catalog.entries })
    ) {
      return "catalog digest differs from entries";
    }
    return undefined;
  },
  (value) => {
    const input = requireJsonObject(assertJson(value), "$");
    return {
      ...input,
      contextSource: assertJson(input["contextSource"]),
    };
  },
);

const chatRootOutputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/output",
  "program_output",
  { type: "string" },
  (value) => (typeof value === "string" ? undefined : "chat program output must be a string"),
);

export const manifest = defineDurableProgramManifest<ChatProgramInput, string>({
  programId: "sweatpants.chat-root",
  version: "1.5.0",
  digest: sha256("sweatpants.chat-root@1.5.0:workflow-sample-pull"),
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
