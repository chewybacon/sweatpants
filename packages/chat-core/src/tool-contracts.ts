import { createContext, type Operation, type Stream } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import type { ToolCall } from "./messages.ts";

// -----------------------------------------------------------------------------
// Tool inventory contracts
// -----------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ToolCapabilities {
  inline?: boolean;
  client?: boolean;
  elicits?: boolean;
  samples?: boolean;
}

export interface ToolInventoryEntry {
  definition: ToolDefinition;
  capabilities?: ToolCapabilities;
  metadata?: Record<string, unknown>;
}

export interface ToolInventory {
  list(): Operation<ToolInventoryEntry[]>;
  resolve(name: string): Operation<ToolInventoryEntry | null>;
}

export type ToolExposurePhase = "outer-chat" | "sample";

export interface SamplingToolDefinitionLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export interface ToolExposureRequest {
  phase: ToolExposurePhase;
  entries?: ToolInventoryEntry[];
  request?: unknown;
  persona?: unknown;
  enabledTools?: true | string[];
  enabledPlugins?: string[];
  sampleTools?: SamplingToolDefinitionLike[];
  metadata?: Record<string, unknown>;
}

export interface ToolExposurePolicy {
  filter(request: ToolExposureRequest): Operation<ToolDefinition[]>;
}

export class ToolInventoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolInventoryError";
  }
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

export const ToolInventoryContext = createContext<ToolInventory>("ToolInventory");
export const ToolExposurePolicyContext = createContext<ToolExposurePolicy>("ToolExposurePolicy");

export function createToolInventory(entries: ToolInventoryEntry[]): ToolInventory {
  const ordered = [...entries];
  const byName = new Map<string, ToolInventoryEntry>();

  for (const entry of ordered) {
    const name = entry.definition.name;
    if (!name || typeof name !== "string") {
      throw new ToolInventoryError(
        "TOOL_NAME_INVALID",
        "Tool inventory entry requires a canonical definition.name",
      );
    }
    if (byName.has(name)) {
      throw new ToolInventoryError(
        "TOOL_NAME_DUPLICATE",
        `Duplicate tool name in inventory: ${name}`,
      );
    }
    byName.set(name, entry);
  }

  return {
    *list(): Operation<ToolInventoryEntry[]> {
      return ordered;
    },
    *resolve(name: string): Operation<ToolInventoryEntry | null> {
      return byName.get(name) ?? null;
    },
  };
}

function stripDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
  };
}

function sampleDefinition(tool: SamplingToolDefinitionLike): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ??
      tool.inputSchema ?? { type: "object", properties: {}, required: [] },
  };
}

export const defaultToolExposurePolicy: ToolExposurePolicy = {
  *filter(request: ToolExposureRequest): Operation<ToolDefinition[]> {
    if (request.phase === "sample") {
      return (request.sampleTools ?? []).map(sampleDefinition);
    }

    const entries = request.entries ?? [];
    let selected = entries;

    if (request.enabledTools !== true && Array.isArray(request.enabledTools)) {
      const enabled = new Set(request.enabledTools);
      selected = selected.filter((entry) => enabled.has(entry.definition.name));
    }

    if (request.enabledPlugins && request.enabledPlugins.length > 0) {
      const enabled = new Set(request.enabledPlugins);
      const existing = new Set(selected.map((entry) => entry.definition.name));
      selected = [
        ...selected,
        ...entries.filter(
          (entry) => enabled.has(entry.definition.name) && !existing.has(entry.definition.name),
        ),
      ];
    }

    return selected.map((entry) => stripDefinition(entry.definition));
  },
};

export const ToolInventoryApi = {
  *list(): Operation<ToolInventoryEntry[]> {
    const inventory = yield* ToolInventoryContext.get();
    if (!inventory) {
      throw new ToolInventoryError(
        "TOOL_INVENTORY_NOT_CONFIGURED",
        "Tool inventory not configured. Install a ToolInventory in scope.",
      );
    }
    return yield* inventory.list();
  },

  *resolve(name: string): Operation<ToolInventoryEntry> {
    const inventory = yield* ToolInventoryContext.get();
    if (!inventory) {
      throw new ToolInventoryError(
        "TOOL_INVENTORY_NOT_CONFIGURED",
        "Tool inventory not configured. Install a ToolInventory in scope.",
      );
    }
    const entry = yield* inventory.resolve(name);
    if (!entry) {
      throw new ToolInventoryError("TOOL_NOT_FOUND", `Tool not found: ${name}`);
    }
    return entry;
  },
};

export const ToolExposureApi = {
  *definitions(request: ToolExposureRequest): Operation<ToolDefinition[]> {
    const policy = (yield* ToolExposurePolicyContext.get()) ?? defaultToolExposurePolicy;
    return yield* policy.filter(request);
  },
};

// -----------------------------------------------------------------------------
// Tool runtime contracts
// -----------------------------------------------------------------------------

export interface ToolExecutionRef {
  runtimeId: string;
  executionId: string;
  callId: string;
  toolName: string;
  sessionId?: string;
}

export interface ToolExecuteRequest {
  entry: ToolInventoryEntry;
  call: ToolCall;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolContinuationInput {
  type: "elicit_response";
  elicitId?: string;
  result: unknown;
}

export interface ToolResumeRequest {
  ref: ToolExecutionRef;
  input: ToolContinuationInput;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionError {
  code?: string;
  message: string;
  cause?: unknown;
}

export interface ElicitToolRequest {
  elicitId: string;
  key: string;
  message: string;
  schema: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export type ToolExecutionEvent =
  | { type: "progress"; lsn?: number; timestamp?: number; message?: string; progress?: number }
  | { type: "log"; lsn?: number; timestamp?: number; level?: string; message: string }
  | {
      type: "elicit_request";
      lsn?: number;
      timestamp?: number;
      elicitId: string;
      key: string;
      message: string;
      schema: Record<string, unknown>;
      context?: Record<string, unknown>;
    }
  | {
      type: "sample_request";
      lsn?: number;
      timestamp?: number;
      sampleId: string;
      messages?: unknown[];
      systemPrompt?: string;
      maxTokens?: number;
      modelPreferences?: unknown;
      tools?: unknown[];
      toolChoice?: unknown;
      schema?: Record<string, unknown>;
    }
  | { type: "sample_response_queued"; lsn?: number; timestamp?: number }
  | { type: "result"; lsn?: number; timestamp?: number; result: unknown }
  | {
      type: "error";
      lsn?: number;
      timestamp?: number;
      message: string;
      code?: string;
      name?: string;
      stack?: string;
    }
  | { type: "cancelled"; lsn?: number; timestamp?: number; reason?: string };

export type ToolExecution =
  | { kind: "completed"; ref: ToolExecutionRef; result: unknown }
  | { kind: "failed"; ref: ToolExecutionRef; error: ToolExecutionError }
  | { kind: "awaiting_elicit"; ref: ToolExecutionRef; request: ElicitToolRequest }
  | { kind: "running"; ref: ToolExecutionRef; events: Stream<ToolExecutionEvent, void> };

export type PendingToolRequest = { type: "elicit" } & ElicitToolRequest;

export interface PendingToolExecution {
  ref: ToolExecutionRef;
  status: "awaiting_elicit" | "running" | "stale";
  request?: PendingToolRequest;
  lastEventLSN?: number;
  createdAt: number;
  updatedAt: number;
}

export type ToolContinuationPayload = {
  type: "elicit_response";
  callId: string;
  toolName: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  result: unknown;
};

export interface ToolRuntime {
  runtimeId(): Operation<string>;
  execute(request: ToolExecuteRequest): Operation<ToolExecution>;
  resume(request: ToolResumeRequest): Operation<ToolExecution>;
  abort(ref: ToolExecutionRef, reason?: string): Operation<void>;
}

export interface ToolExecutionContext {
  runtimeId: string;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionStrategy {
  readonly id: string;
  readonly toolNames?: readonly string[];
  canExecute(
    entry: ToolInventoryEntry,
    call: ToolCall,
    ctx: ToolExecutionContext,
  ): boolean | Operation<boolean>;
  execute(
    entry: ToolInventoryEntry,
    call: ToolCall,
    ctx: ToolExecutionContext,
  ): Operation<ToolExecution>;
  resume?(
    ref: ToolExecutionRef,
    input: ToolContinuationInput,
    ctx: ToolExecutionContext,
  ): Operation<ToolExecution>;
  abort?(
    ref: ToolExecutionRef,
    reason: string | undefined,
    ctx: ToolExecutionContext,
  ): Operation<void>;
}

export class ToolRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}

function unavailable(): never {
  throw new ToolRuntimeError(
    "TOOL_RUNTIME_NOT_CONFIGURED",
    "Tool runtime not configured. Install a ToolRuntime in scope.",
  );
}

/** Optional Host seam: callers probe `isInstalled()` before resolving it. */
export const ToolRuntimePort = definePort<ToolRuntime>("tool-runtime", {
  *runtimeId(): Operation<string> {
    return unavailable();
  },
  *execute(_request: ToolExecuteRequest): Operation<ToolExecution> {
    return unavailable();
  },
  *resume(_request: ToolResumeRequest): Operation<ToolExecution> {
    return unavailable();
  },
  *abort(_ref: ToolExecutionRef, _reason?: string): Operation<void> {
    return unavailable();
  },
});

export const ToolRuntimeApi = ToolRuntimePort.api;

function* assertOwnedBy(runtime: ToolRuntime, ref: ToolExecutionRef): Operation<void> {
  const id = yield* runtime.runtimeId();
  if (ref.runtimeId !== id) {
    throw new ToolRuntimeError(
      "WRONG_TOOL_RUNTIME",
      `Wrong tool runtime: expected ${id}, received ${ref.runtimeId}`,
    );
  }
}

export function installToolRuntime(runtime: ToolRuntime): Operation<void> {
  return ToolRuntimePort.installDriver({
    runtimeId: () => runtime.runtimeId(),
    execute: (request) => runtime.execute(request),
    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      yield* assertOwnedBy(runtime, request.ref);
      return yield* runtime.resume(request);
    },
    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      yield* assertOwnedBy(runtime, ref);
      yield* runtime.abort(ref, reason);
    },
  });
}
