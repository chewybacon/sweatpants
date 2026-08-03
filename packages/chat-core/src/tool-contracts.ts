import { createContext, type Operation } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import type { PortableToolDefinition, ToolInventoryEntry } from "@sweatpants/tool-runtime";

export type ToolExposurePhase = "outer-chat" | "sample";

export interface SamplingToolDefinitionLike {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  parameters?: JsonObject;
}

export interface ToolExposureRequest {
  phase: ToolExposurePhase;
  entries?: ToolInventoryEntry[];
  request?: unknown;
  persona?: unknown;
  enabledTools?: true | string[];
  sampleTools?: SamplingToolDefinitionLike[];
  metadata?: Record<string, unknown>;
}

export interface ToolExposurePolicy {
  filter(request: ToolExposureRequest): Operation<PortableToolDefinition[]>;
}

export class ToolExposureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolExposureError";
  }
}

function stripDefinition(definition: PortableToolDefinition): PortableToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
  };
}

function sampleDefinition(tool: SamplingToolDefinitionLike): PortableToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ??
      tool.inputSchema ?? { type: "object", properties: {}, required: [] },
  };
}

export const ToolExposurePolicyContext = createContext<ToolExposurePolicy>("ToolExposurePolicy");

export const defaultToolExposurePolicy: ToolExposurePolicy = {
  *filter(request: ToolExposureRequest): Operation<PortableToolDefinition[]> {
    if (request.phase === "sample") {
      return (request.sampleTools ?? []).map(sampleDefinition);
    }

    const entries = request.entries ?? [];
    let selected = entries;

    if (request.enabledTools !== true && Array.isArray(request.enabledTools)) {
      const enabled = new Set(request.enabledTools);
      selected = selected.filter((entry) => enabled.has(entry.definition.name));
    }

    return selected.map((entry) => stripDefinition(entry.definition));
  },
};

export const ToolExposureApi = {
  *definitions(request: ToolExposureRequest): Operation<PortableToolDefinition[]> {
    const policy = (yield* ToolExposurePolicyContext.get()) ?? defaultToolExposurePolicy;
    return yield* policy.filter(request);
  },
};
