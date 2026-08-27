import { assertJson, parser, sha256, type Json } from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  EphemeralToolContinueRequest,
  EphemeralToolRequest,
  EphemeralToolDisposition,
} from "@sweatpants/durable-execution";
import type { EffectDefinition } from "@sweatpants/durable-effects";
import { MODEL_SAMPLE_PULL_SCHEMA_ENTRIES } from "@sweatpants/model-sampling";
import { z } from "zod";

/** Pinned identity of the built-in foreign-tool adapter program. */
export const FOREIGN_TOOL_ADAPTER_PROGRAM = Object.freeze({
  id: "sweatpants.foreign-tool-adapter",
  version: "1.3.0",
  digest: sha256("sweatpants.foreign-tool-adapter@1.3.0:workflow-pulls"),
});

const FOREIGN_DURABILITIES = [
  "opaque",
  "ephemeral_handle",
  "resumable_handle",
  "server_task",
  "crank_native",
] as const;
const foreignStartSchema = z.strictObject({
  driver: z.string().min(1).max(512),
  tool: z.string().min(1).max(512),
  input: z.json(),
  durability: z.enum(FOREIGN_DURABILITIES),
  route: z.string().max(4_096).optional(),
});
const foreignContinueSchema = z.strictObject({
  continuation: z.strictObject({
    driver: z.string().min(1).max(512),
    state: z.json(),
  }),
  response: z.strictObject({
    kind: z.enum(["sample", "elicit", "cancel"]),
    value: z.json(),
  }),
});
const foreignStartParser = parser(foreignStartSchema);
const foreignContinueParser = parser(foreignContinueSchema);

function builtinDescriptor(
  identity: string,
  role: string,
  projection: Json,
): PortableSchemaDescriptor {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
}

function guardSchema(guard: (value: unknown) => string | undefined): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants",
      validate(value: unknown) {
        const message = guard(value);
        return message === undefined ? { value: assertJson(value) } : { issues: [{ message }] };
      },
    },
  };
}

const anyJsonGuard = (value: unknown): string | undefined => {
  try {
    assertJson(value);
    return undefined;
  } catch {
    return "value must be canonical JSON";
  }
};

const FOREIGN_TOOL_START_INPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/start-input",
  "effect_input",
  {
    type: "object",
    required: ["driver", "tool", "input", "durability"],
    properties: {
      driver: { type: "string" },
      tool: { type: "string" },
      input: true,
      durability: { enum: [...FOREIGN_DURABILITIES] },
      route: { type: "string" },
    },
    additionalProperties: false,
  },
);

const FOREIGN_TOOL_START_OUTPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/start-output",
  "effect_output",
  true,
);

const FOREIGN_TOOL_CONTINUE_INPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/continue-input",
  "effect_input",
  {
    type: "object",
    required: ["continuation", "response"],
    properties: {
      continuation: {
        type: "object",
        required: ["driver", "state"],
        properties: { driver: { type: "string" }, state: true },
        additionalProperties: false,
      },
      response: {
        type: "object",
        required: ["kind", "value"],
        properties: { kind: { enum: ["sample", "elicit", "cancel"] }, value: true },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
);

const FOREIGN_TOOL_CONTINUE_OUTPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/continue-output",
  "effect_output",
  true,
);

/** Program-input descriptor for the built-in foreign adapter program. */
export const FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/program-input",
  "program_input",
  {
    type: "object",
    required: ["driver", "tool", "input", "durability"],
    properties: {
      driver: { type: "string" },
      tool: { type: "string" },
      input: true,
      durability: { enum: [...FOREIGN_DURABILITIES] },
      route: { type: "string" },
    },
    additionalProperties: false,
  },
);

/** Program-output descriptor for the built-in foreign adapter program. */
export const FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/program-output",
  "program_output",
  true,
);

/** Accepted-content descriptor for lifted foreign elicitations (any canonical JSON). */
export const FOREIGN_INPUT_RESPONSE_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/foreign-input-response",
  "elicit_response",
  true,
);

/** Context descriptor for lifted foreign elicitations (any canonical JSON). */
export const FOREIGN_INPUT_CONTEXT_DESCRIPTOR = builtinDescriptor(
  "sweatpants.foreign-tool-adapter/foreign-input-context",
  "elicit_context",
  true,
);

const foreignStartGuard = (value: unknown): string | undefined =>
  foreignStartParser.parse(value).ok ? undefined : "foreign start request is invalid";

const foreignContinueGuard = (value: unknown): string | undefined =>
  foreignContinueParser.parse(value).ok ? undefined : "foreign continue request is invalid";

/** Runtime validator entries for every built-in foreign adapter descriptor. */
export function foreignToolSchemaEntries(): Array<{
  descriptor: PortableSchemaDescriptor;
  schema: StandardSchemaV1;
}> {
  return [
    { descriptor: FOREIGN_TOOL_START_INPUT_DESCRIPTOR, schema: guardSchema(foreignStartGuard) },
    { descriptor: FOREIGN_TOOL_START_OUTPUT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    {
      descriptor: FOREIGN_TOOL_CONTINUE_INPUT_DESCRIPTOR,
      schema: guardSchema(foreignContinueGuard),
    },
    { descriptor: FOREIGN_TOOL_CONTINUE_OUTPUT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    ...MODEL_SAMPLE_PULL_SCHEMA_ENTRIES,
    { descriptor: FOREIGN_INPUT_RESPONSE_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    { descriptor: FOREIGN_INPUT_CONTEXT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    { descriptor: FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR, schema: guardSchema(foreignStartGuard) },
    { descriptor: FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
  ];
}

const startDefinition: EffectDefinition<EphemeralToolRequest, EphemeralToolDisposition> = {
  name: "foreign.tool.start",
  version: "1",
  inputSchema: FOREIGN_TOOL_START_INPUT_DESCRIPTOR,
  outputSchema: FOREIGN_TOOL_START_OUTPUT_DESCRIPTOR,
  // Resolved by the in-host effect registry: no resolver survives host loss, so
  // a detached attempt settles as a coded indeterminate outcome.
  retrySafety: { mode: "unsafe" },
};
/** Effect contract for starting a foreign driver invocation exactly once. */
export const FOREIGN_TOOL_START_EFFECT = Object.freeze(startDefinition);

const continueDefinition: EffectDefinition<EphemeralToolContinueRequest, EphemeralToolDisposition> =
  {
    name: "foreign.tool.continue",
    version: "1",
    inputSchema: FOREIGN_TOOL_CONTINUE_INPUT_DESCRIPTOR,
    outputSchema: FOREIGN_TOOL_CONTINUE_OUTPUT_DESCRIPTOR,
    // See `foreign.tool.start`: the resolver is in-host and cannot outlive it.
    retrySafety: { mode: "unsafe" },
  };
/** Effect contract for applying one response to foreign continuation state. */
export const FOREIGN_TOOL_CONTINUE_EFFECT = Object.freeze(continueDefinition);

/** Canonical live ToolInvocationHost identity for one foreign adapter task. */
export function foreignToolInvocationId(sessionId: string, taskId: string): string {
  return `foreign:${sessionId}:${taskId}`;
}
