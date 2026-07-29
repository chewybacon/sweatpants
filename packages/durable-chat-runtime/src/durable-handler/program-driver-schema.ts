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

export type ThinCatalogEntry =
  | { kind: "program"; target: string; program: NativeIdentity }
  | {
      kind: "foreign-tool";
      target: string;
      driver: "tool-session" | "framework-tool-runtime";
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
    if (!isJsonObject(value) || !Array.isArray(value["messages"])) {
      return "chat program input requires messages";
    }
    if (
      !Number.isSafeInteger(value["maxIterations"]) ||
      (value["maxIterations"] as number) < 1 ||
      (value["maxIterations"] as number) > 100
    ) {
      return "maxIterations must be an integer between 1 and 100";
    }
    if (
      value["toolChoice"] !== undefined &&
      !["auto", "none", "required"].includes(String(value["toolChoice"]))
    ) {
      return "toolChoice is invalid";
    }
    const catalog = value["catalog"];
    if (!isJsonObject(catalog) || catalog["version"] !== 1 || !isJsonObject(catalog["entries"])) {
      return "catalog must be a versioned entry map";
    }
    if (catalog["digest"] !== canonicalSnapshot({ version: 1, entries: catalog["entries"] }).sha) {
      return "catalog digest differs from entries";
    }
    const allowed = new Set(["messages", "systemPrompt", "toolChoice", "maxIterations", "catalog"]);
    if (!Object.keys(value).every((key) => allowed.has(key))) {
      return "chat program input has unexpected keys";
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
