import { createContext, type Operation } from "effection";
import type { ToolInventoryEntry } from "@sweatpants/tool-runtime";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";

export type ToolExposurePhase = "outer-chat";

export interface ToolExposureRequest {
  phase: ToolExposurePhase;
  entries?: ToolInventoryEntry[];
  request?: unknown;
  persona?: unknown;
  /** Host-selected presentation subset; executable authorization comes from `entries`. */
  enabledTools?: true | string[];
  metadata?: Record<string, unknown>;
}

export interface ToolExposurePolicy {
  filter(request: ToolExposureRequest): Operation<ChatToolDefinition[]>;
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

function stripDefinition(definition: ChatToolDefinition): ChatToolDefinition {
  return definition;
}

export const ToolExposurePolicyContext = createContext<ToolExposurePolicy>("ToolExposurePolicy");

export const defaultToolExposurePolicy: ToolExposurePolicy = {
  *filter(request: ToolExposureRequest): Operation<ChatToolDefinition[]> {
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
  *definitions(request: ToolExposureRequest): Operation<ChatToolDefinition[]> {
    const policy = (yield* ToolExposurePolicyContext.get()) ?? defaultToolExposurePolicy;
    return yield* policy.filter(request);
  },
};
