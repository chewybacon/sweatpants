import type { AnyToolDefinition } from "@sweatpants/core";
import { resource, type Operation, type Stream } from "effection";
import {
  ToolRuntimeContext,
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  toToolParameterJsonSchema,
  validateToolParameters,
  type ToolCall,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionEvent,
  type ToolExecutionStrategy,
  type ToolInventoryEntry,
  type ToolRuntime,
} from "@sweatpants/framework/chat";
import type {
  WireElicitResult,
  ToolSession as McpToolSession,
  ToolSessionEvent as McpToolSessionEvent,
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
  ToolSessionStore,
} from "@sweatpants/framework/chat/mcp-tools";
import { createInMemoryToolSessionStore } from "./in-memory-store.ts";
import { createToolSessionRegistry, type ToolSessionRegistryOptions } from "./session-registry.ts";

type LocalImplementation = { kind: "mcp"; tool: AnyToolDefinition };
type InventoryToolDefinition = ToolInventoryEntry["definition"];

export interface LocalToolRuntimeDriverOptions {
  id?: string;
  tools?: AnyToolDefinition[];
  registry?: ToolSessionRegistry;
  store?: ToolSessionStore;
  samplingProvider?: ToolSessionSamplingProvider;
  registryOptions?: Omit<ToolSessionRegistryOptions, "samplingProvider">;
}

function parametersToSchema(parameters: unknown): Record<string, unknown> {
  return toToolParameterJsonSchema(parameters);
}

function sessionToolDefinition(tool: AnyToolDefinition): InventoryToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersToSchema(tool.parameters),
  };
}

export function createToolInventoryEntry<T extends AnyToolDefinition>(
  tool: T,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry<{ kind: "mcp"; tool: T }> {
  return {
    definition: sessionToolDefinition(tool),
    implementation: { kind: "mcp", tool } as { kind: "mcp"; tool: T },
    capabilities: {
      session: true,
      worker: true,
      elicits: Boolean(tool.capabilities?.elicitation),
      samples: Boolean(tool.capabilities?.sampling),
    },
    ...(metadata ? { metadata } : {}),
  };
}

function validateParams(tool: AnyToolDefinition, params: unknown, callId: string): unknown {
  return validateToolParameters({
    schema: tool.parameters,
    params,
    toolName: tool.name,
    callId,
  });
}

function isLocalImplementation(value: unknown): value is LocalImplementation {
  return !!value && typeof value === "object" && "kind" in value;
}

function eventStreamFromSession(session: McpToolSession): Stream<ToolExecutionEvent, void> {
  return resource(function* (provide) {
    const subscription = yield* session.events();
    yield* provide({
      *next(): Operation<IteratorResult<ToolExecutionEvent, void>> {
        return yield* subscription.next();
      },
    });
  });
}

function mcpEventToExecution(
  runtimeId: string,
  call: ToolCall,
  session: McpToolSession,
  event: McpToolSessionEvent | null,
): ToolExecution {
  const ref = createToolExecutionRef({
    runtimeId,
    executionId: session.id,
    sessionId: session.id,
    callId: call.id,
    toolName: session.toolName,
  });
  if (!event) {
    return {
      kind: "failed",
      ref,
      error: { code: "SESSION_ENDED", message: "Tool session ended unexpectedly" },
    };
  }

  switch (event.type) {
    case "elicit_request":
      return {
        kind: "awaiting_elicit",
        ref,
        request: {
          elicitId: String(event.elicitId),
          key: String((event as { key?: unknown }).key ?? ""),
          message: String((event as { message?: unknown }).message ?? ""),
          schema:
            (event as { schema?: unknown }).schema &&
            typeof (event as { schema?: unknown }).schema === "object"
              ? (event as { schema: Record<string, unknown> }).schema
              : { type: "object", properties: {}, required: [] },
        },
      };
    case "result":
      return { kind: "completed", ref, result: (event as { result: unknown }).result };
    case "error":
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_ERROR",
          message: String((event as { message?: unknown }).message ?? "Tool failed"),
        },
      };
    case "cancelled":
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_CANCELLED",
          message: String((event as { reason?: unknown }).reason ?? "Tool execution was cancelled"),
        },
      };
    default:
      return { kind: "running", ref, events: eventStreamFromSession(session) };
  }
}

function afterLsnFromElicitId(elicitId: string | undefined): number | undefined {
  if (!elicitId) return undefined;
  const requestMatch = /:req:(\d+)$/.exec(elicitId);
  if (requestMatch?.[1]) return Number(requestMatch[1]);
  const legacyMatch = /:elicit:(\d+)$/.exec(elicitId);
  if (legacyMatch?.[1]) return Number(legacyMatch[1]) + 1;
  return undefined;
}

function* nextMcpExecution(
  runtimeId: string,
  call: ToolCall,
  session: McpToolSession,
  samplingProvider: ToolSessionSamplingProvider,
  afterLSN?: number,
): Operation<ToolExecution> {
  const subscription = yield* session.events(afterLSN);

  while (true) {
    const next = yield* subscription.next();
    if (next.done) return mcpEventToExecution(runtimeId, call, session, null);

    if (next.value.type === "sample_request") {
      const result = yield* samplingProvider.sample(next.value.messages, {
        ...(next.value.systemPrompt ? { systemPrompt: next.value.systemPrompt } : {}),
        ...(next.value.maxTokens !== undefined ? { maxTokens: next.value.maxTokens } : {}),
        ...(next.value.tools ? { tools: next.value.tools } : {}),
        ...(next.value.toolChoice ? { toolChoice: next.value.toolChoice } : {}),
        ...(next.value.schema ? { schema: next.value.schema } : {}),
      });
      yield* session.respondToSample(next.value.sampleId, result);
      continue;
    }

    if (
      next.value.type === "progress" ||
      next.value.type === "log" ||
      next.value.type === "sample_response_queued"
    ) {
      continue;
    }

    return mcpEventToExecution(runtimeId, call, session, next.value);
  }
}

export interface LocalSessionToolExecutionStrategyOptions {
  id?: string;
  registry: ToolSessionRegistry;
  samplingProvider: ToolSessionSamplingProvider;
  tools?: AnyToolDefinition[];
}

export function createLocalSessionToolExecutionStrategy(
  options: LocalSessionToolExecutionStrategyOptions,
): ToolExecutionStrategy {
  const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool] as const));
  return {
    id: options.id ?? "local-session",
    canExecute(entry, call) {
      if (isLocalImplementation(entry.implementation) && entry.implementation.kind === "mcp")
        return true;
      return toolsByName.has(call.function.name);
    },
    *execute(entry, call, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const tool =
        isLocalImplementation(entry.implementation) && entry.implementation.kind === "mcp"
          ? entry.implementation.tool
          : toolsByName.get(call.function.name);
      if (!tool)
        throw new ToolRuntimeError(
          "NO_MATCHING_TOOL_STRATEGY",
          `Local session strategy cannot execute tool: ${call.function.name}`,
        );
      const params = validateParams(tool, call.function.arguments, call.id);
      const session = yield* options.registry.create(tool, params, {
        sessionId: call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return yield* nextMcpExecution(ctx.runtimeId, call, session, options.samplingProvider);
    },
    *resume(ref, input, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const sessionId = ref.sessionId ?? ref.executionId;
      const session = yield* options.registry.get(sessionId);
      if (!session)
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      if (ref.toolName && session.toolName !== ref.toolName)
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      if (!input.elicitId)
        throw new ToolRuntimeError("ELICIT_ID_REQUIRED", "Elicit continuation requires elicitId");
      yield* session.respondToElicit(input.elicitId, input.result as WireElicitResult<unknown>);
      return yield* nextMcpExecution(
        ctx.runtimeId,
        {
          id: ref.callId,
          type: "function",
          function: { name: ref.toolName || session.toolName, arguments: {} },
        },
        session,
        options.samplingProvider,
        afterLsnFromElicitId(input.elicitId),
      );
    },
    *abort(ref, reason): Operation<void> {
      const sessionId = ref.sessionId ?? ref.executionId;
      const session = yield* options.registry.get(sessionId);
      if (!session)
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      yield* session.cancel(reason);
    },
  };
}

export function* createLocalToolRuntimeDriver(
  options: LocalToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const runtimeId = options.id ?? "local";
  const samplingProvider = options.samplingProvider ?? {
    *sample() {
      throw new Error("Local tool runtime sampling provider not configured");
    },
  };
  const registry =
    options.registry ??
    (yield* createToolSessionRegistry(options.store ?? createInMemoryToolSessionStore(), {
      ...(options.registryOptions ?? {}),
      samplingProvider,
    }));

  return createStrategyToolRuntime({
    id: runtimeId,
    strategies: [
      createLocalSessionToolExecutionStrategy({
        id: runtimeId,
        registry,
        samplingProvider,
        ...(options.tools ? { tools: options.tools } : {}),
      }),
    ],
  });
}

export function* installLocalToolRuntime(
  options: LocalToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = yield* createLocalToolRuntimeDriver(options);
  yield* ToolRuntimeContext.set(driver);
  return driver;
}
