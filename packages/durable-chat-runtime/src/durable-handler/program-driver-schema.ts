import { MODEL_SAMPLE_EFFECT, MODEL_SAMPLE_SCHEMA_ENTRIES } from "@sweatpants/model-sampling";
import { decodeChatHistoryEntries } from "@sweatpants/chat-core";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { defineDurableProgramManifest } from "@sweatpants/durable-execution";
import {
  assertJson,
  canonicalSnapshot,
  requireJsonObject,
  type Json,
  type JsonObject,
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
        kind: "foreign-tool";
        target: string;
        driver: "tool-session" | "chat-tool-runtime";
        tool: string;
        durability: "ephemeral_handle";
      };
};

/** Atomic model exposure plus execution target artifact accepted by chat-root. */
export type ChatToolCatalog = {
  version: 1;
  digest: string;
  entries: Record<string, ChatToolCatalogEntry>;
};

export type ChatProgramInput = {
  messages: Json[];
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
    kind: z.literal("foreign-tool"),
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
  messages: z.array(z.json()).max(10_000),
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

export const modelSample = MODEL_SAMPLE_EFFECT;

const chatRootInputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/input",
  "program_input",
  {
    type: "object",
    required: ["messages", "maxIterations", "catalog"],
    properties: {
      messages: { type: "array", items: true },
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
                        kind: { const: "foreign-tool" },
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
    if (!parsed.success) return "chat program input structure is invalid";
    if (
      parsed.data.catalog.digest !==
      canonicalSnapshot({ version: 1, entries: parsed.data.catalog.entries }).sha
    ) {
      return "catalog digest differs from entries";
    }
    return undefined;
  },
  (value) => {
    const input = requireJsonObject(assertJson(value), "$");
    const messages = decodeChatHistoryEntries(input["messages"], "$.messages");
    return {
      ...input,
      messages: messages.map((entry) => assertJson(entry)),
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
  version: "1.4.0",
  digest: "9c9ef3577a2d1190d46f49d230c06554291d663019dbae7b85cdf457b4f5b047",
  inputSchema: chatRootInputDescriptor,
  outputSchema: chatRootOutputDescriptor,
  elicits: {},
  effects: { [modelSample.name]: modelSample },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
});

/**
 * Digest-keyed validator entries for the built-in chat-root program and its
 * model-sampling effect. Deployments merge these with their generated tool
 * catalogs into the journal authority's schema registry.
 */
export function programDriverChatEngineSchemaEntries(): readonly SchemaBinding[] {
  return [...MODEL_SAMPLE_SCHEMA_ENTRIES, ...chatEngineSchemaEntries];
}
