import { assertJson } from "./canonical.ts";
import {
  createPortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "./schema-descriptor.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  DurableChildDescriptor,
  EffectDefinition,
  ForeignToolContinueRequest,
  ForeignToolRequest,
  ForeignToolDisposition,
} from "./durable-types.ts";
import { MODEL_SAMPLE_EFFECT, MODEL_SAMPLE_SCHEMA_ENTRIES } from "./model-sample-contract.ts";
import type { Json } from "./types.ts";

/** Pinned identity of the built-in foreign-tool adapter program. */
export const FOREIGN_TOOL_ADAPTER_PROGRAM = Object.freeze({
  id: "sweatpants.foreign-tool-adapter",
  version: "1.0.0",
  digest: "664eb30db1cb9cff506e842d4aaa35ece6c5afb0179e98841a2a27fe1f2d97b2",
});

const FOREIGN_DURABILITIES = [
  "opaque",
  "ephemeral_handle",
  "resumable_handle",
  "server_task",
  "crank_native",
] as const;

function builtinDescriptor(
  identity: string,
  role: PortableSchemaRole,
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const foreignStartGuard = (value: unknown): string | undefined => {
  const structural = anyJsonGuard(value);
  if (structural) {
    return structural;
  }
  if (!isRecordValue(value)) {
    return "foreign start request must be an object";
  }
  if (typeof value["driver"] !== "string" || typeof value["tool"] !== "string") {
    return "driver and tool must be strings";
  }
  if (!("input" in value)) {
    return "input is required";
  }
  if (!FOREIGN_DURABILITIES.includes(value["durability"] as never)) {
    return "durability is invalid";
  }
  if (value["route"] !== undefined && typeof value["route"] !== "string") {
    return "route must be a string";
  }
  const allowed = new Set(["driver", "tool", "input", "durability", "route"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    return "foreign start request has unexpected keys";
  }
  return undefined;
};

const foreignContinueGuard = (value: unknown): string | undefined => {
  const structural = anyJsonGuard(value);
  if (structural) {
    return structural;
  }
  if (!isRecordValue(value)) {
    return "foreign continue request must be an object";
  }
  const continuation = value["continuation"];
  const response = value["response"];
  if (
    !isRecordValue(continuation) ||
    typeof continuation["driver"] !== "string" ||
    !("state" in continuation)
  ) {
    return "continuation is invalid";
  }
  if (
    !isRecordValue(response) ||
    !["sample", "elicit", "cancel"].includes(String(response["kind"])) ||
    !("value" in response)
  ) {
    return "response is invalid";
  }
  const allowed = new Set(["continuation", "response"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    return "foreign continue request has unexpected keys";
  }
  return undefined;
};

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
    ...MODEL_SAMPLE_SCHEMA_ENTRIES,
    { descriptor: FOREIGN_INPUT_RESPONSE_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    { descriptor: FOREIGN_INPUT_CONTEXT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
    { descriptor: FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR, schema: guardSchema(foreignStartGuard) },
    { descriptor: FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR, schema: guardSchema(anyJsonGuard) },
  ];
}

const startDefinition: EffectDefinition<ForeignToolRequest, ForeignToolDisposition> = {
  name: "foreign.tool.start",
  version: "1",
  inputSchema: FOREIGN_TOOL_START_INPUT_DESCRIPTOR,
  outputSchema: FOREIGN_TOOL_START_OUTPUT_DESCRIPTOR,
  retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
};
/** Effect contract for starting a foreign driver invocation exactly once. */
export const FOREIGN_TOOL_START_EFFECT = Object.freeze(startDefinition);

const continueDefinition: EffectDefinition<ForeignToolContinueRequest, ForeignToolDisposition> = {
  name: "foreign.tool.continue",
  version: "1",
  inputSchema: FOREIGN_TOOL_CONTINUE_INPUT_DESCRIPTOR,
  outputSchema: FOREIGN_TOOL_CONTINUE_OUTPUT_DESCRIPTOR,
  retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
};
/** Effect contract for applying one response to foreign continuation state. */
export const FOREIGN_TOOL_CONTINUE_EFFECT = Object.freeze(continueDefinition);

/** Canonical model-sampling effect used by foreign ToolSession lifting. */
export const FOREIGN_MODEL_SAMPLE_EFFECT = MODEL_SAMPLE_EFFECT;

/** Projects a foreign request into the pinned adapter child descriptor. */
export function foreignToolAdapterChild(request: ForeignToolRequest): DurableChildDescriptor {
  return { ...FOREIGN_TOOL_ADAPTER_PROGRAM, input: request };
}
