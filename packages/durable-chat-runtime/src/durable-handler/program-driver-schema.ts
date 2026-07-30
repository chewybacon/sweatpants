import type { ModelSampleRequest } from "@sweatpants/durable-effects";
import { MODEL_SAMPLE_EFFECT, MODEL_SAMPLE_SCHEMA_ENTRIES } from "@sweatpants/durable-effects";
import { defineDurableProgramManifest } from "@sweatpants/durable-execution";
import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type { NativeProgramIdentity as NativeIdentity } from "../program-driver/native-tools.ts";
import { z } from "zod";

export type ThinCatalogEntry =
  | { kind: "program"; target: string; program: NativeIdentity }
  | {
      kind: "foreign-tool";
      target: string;
      driver: "tool-session" | "chat-tool-runtime";
      tool: string;
      durability: "ephemeral_handle";
    };

export type ThinProgramCatalog = {
  version: 1;
  digest: string;
  entries: Record<string, ThinCatalogEntry>;
};

export type ChatProgramInput = ChatSampleRequest & {
  maxIterations: number;
  catalog: ThinProgramCatalog;
};

type ChatSampleRequest = ModelSampleRequest;

const chatEngineSchemaEntries: SchemaBinding[] = [];
const schemaText = z.string().min(1).max(4_096);
const thinCatalogEntrySchema = z.discriminatedUnion("kind", [
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
const chatProgramInputSchema = z.strictObject({
  messages: z.array(z.json()).max(10_000),
  systemPrompt: z.string().max(64 * 1024).optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  maxIterations: z.number().int().min(1).max(100),
  catalog: z.strictObject({
    version: z.literal(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    entries: z.record(schemaText, thinCatalogEntrySchema),
  }),
});

function chatEngineSchema(
  identity: string,
  role: string,
  projection: Json,
  guard: (value: unknown) => string | undefined,
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
      const message = guard(value);
      if (message !== undefined) {
        return { issues: [{ message }] };
      }
      try {
        return { value: assertJson(value) };
      } catch {
        return { issues: [{ message: "value must be canonical JSON" }] };
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
          entries: { type: "object", additionalProperties: true },
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
);

const chatRootOutputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/output",
  "program_output",
  { type: "string" },
  (value) => (typeof value === "string" ? undefined : "chat program output must be a string"),
);

export const manifest = defineDurableProgramManifest<ChatProgramInput, string>({
  programId: "sweatpants.chat-root",
  version: "1.2.0",
  digest: "cd46d11a63f7e556a52b9fc467253bf8b557aa35ac923b8700d2dae557064985",
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
