import type {
  DurableChildDescriptor,
  EffectDefinition,
  ForeignToolContinueRequest,
  ForeignToolDisposition,
  ForeignToolRequest,
} from "./durable-types.ts";
import type { Json } from "./types.ts";

/** Pinned identity of the built-in foreign-tool adapter program. */
export const FOREIGN_TOOL_ADAPTER_PROGRAM = Object.freeze({
  id: "sweatpants.foreign-tool-adapter",
  version: "1.0.0",
  digest: "7e589ef471bf10722d6a236e52c4bd93f948a60cd73823bb7a85e53c7b2790f5",
});

const startDefinition: EffectDefinition<ForeignToolRequest, ForeignToolDisposition> = {
  name: "foreign.tool.start",
  version: "1",
  inputSchema: {
    type: "object",
    required: ["driver", "tool", "input", "durability"],
    properties: {
      driver: { type: "string" },
      tool: { type: "string" },
      input: true,
      durability: {
        enum: ["opaque", "ephemeral_handle", "resumable_handle", "server_task", "crank_native"],
      },
      route: { type: "string" },
    },
    additionalProperties: false,
  },
  outputSchema: true,
  retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
};
/** Effect contract for starting a foreign driver invocation exactly once. */
export const FOREIGN_TOOL_START_EFFECT = Object.freeze(startDefinition);

const continueDefinition: EffectDefinition<ForeignToolContinueRequest, ForeignToolDisposition> = {
  name: "foreign.tool.continue",
  version: "1",
  inputSchema: {
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
        properties: { kind: { enum: ["sample", "elicit"] }, value: true },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  outputSchema: true,
  retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
};
/** Effect contract for applying one response to foreign continuation state. */
export const FOREIGN_TOOL_CONTINUE_EFFECT = Object.freeze(continueDefinition);

const modelSampleDefinition: EffectDefinition<Json, Json> = {
  name: "model.sample",
  version: "1",
  inputSchema: true,
  outputSchema: true,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
};
/** Canonical model-sampling effect used by foreign ToolSession lifting. */
export const FOREIGN_MODEL_SAMPLE_EFFECT = Object.freeze(modelSampleDefinition);

/** Projects a foreign request into the pinned adapter child descriptor. */
export function foreignToolAdapterChild(request: ForeignToolRequest): DurableChildDescriptor {
  return { ...FOREIGN_TOOL_ADAPTER_PROGRAM, input: request };
}
