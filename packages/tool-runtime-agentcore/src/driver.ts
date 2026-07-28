import type { AnyToolContract } from "@sweatpants/core";
import { action, resource, spawn, type Operation, type Stream } from "effection";
import {
  installToolRuntime,
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  validateRuntimeToolParameters,
  type ElicitToolRequest,
  type ToolCall,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionEvent,
  type ToolExecutionStrategy,
  type ToolRuntime,
} from "@sweatpants/framework/chat";
import type {
  WireElicitResult,
  ToolSession as McpToolSession,
  ToolSessionEvent as McpToolSessionEvent,
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/tool-session";
import {
  createAgentCoreToolSessionRegistry,
  type AgentCoreToolSessionRegistryOptions,
} from "./agentcore-session-registry.ts";

type AgentCoreContextModelSelection = { provider: string; id: string };

export interface AgentCoreToolRuntimeDriverOptions {
  /** Stable runtime identifier stored on all execution refs. */
  id?: string;
  /** Executable tool contracts allowed through this runtime. */
  tools: AnyToolContract[];
  /** Existing AgentCore registry. If omitted, registryOptions are used to create one. */
  registry?: ToolSessionRegistry;
  /** Sampling provider used when remote tools emit sample_request events. */
  samplingProvider: ToolSessionSamplingProvider;
  /** Options for creating the AgentCore session registry. */
  registryOptions?: AgentCoreToolSessionRegistryOptions;
}

function toolsByCanonicalName(
  tools: AnyToolContract[],
  owner: string,
): Map<string, AnyToolContract> {
  const byName = new Map<string, AnyToolContract>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new ToolRuntimeError(
        "DUPLICATE_TOOL_STRATEGY",
        `Tool "${tool.name}" is declared multiple times for ${owner}`,
      );
    }
    byName.set(tool.name, tool);
  }
  return byName;
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

function sessionEventToExecution(
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
      error: { code: "SESSION_ENDED", message: "AgentCore tool session ended unexpectedly" },
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
        } satisfies ElicitToolRequest,
      };
    case "result":
      return { kind: "completed", ref, result: (event as { result: unknown }).result };
    case "error":
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_ERROR",
          message: String((event as { message?: unknown }).message ?? "AgentCore tool failed"),
        },
      };
    case "cancelled":
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_CANCELLED",
          message: String(
            (event as { reason?: unknown }).reason ?? "AgentCore tool execution was cancelled",
          ),
        },
      };
    default:
      return { kind: "running", ref, events: eventStreamFromSession(session) };
  }
}

function modelSelectionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): AgentCoreContextModelSelection | undefined {
  const model = metadata?.["model"];
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return undefined;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    return undefined;
  }
  return { provider: provider.trim(), id: id.trim() };
}

function* waitForAbort(signal: AbortSignal): Operation<void> {
  if (signal.aborted) {
    return;
  }
  yield* action<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  });
}

function afterLsnFromPendingId(id: string | undefined): number | undefined {
  if (!id) {
    return undefined;
  }

  const requestMatch = /:req:(\d+)$/.exec(id);
  return requestMatch?.[1] ? Number(requestMatch[1]) : undefined;
}

function* findPendingRequestLsn(
  session: McpToolSession,
  pendingId: string | undefined,
): Operation<number | undefined> {
  if (!pendingId) {
    return undefined;
  }

  const subscription = yield* session.events();
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      return undefined;
    }
    const event = next.value;
    if (event.type === "elicit_request" && String(event.elicitId) === pendingId) {
      return event.lsn;
    }
    if (event.type === "sample_request" && String(event.sampleId) === pendingId) {
      return event.lsn;
    }
  }
}

function* nextAgentCoreExecution(
  runtimeId: string,
  call: ToolCall,
  session: McpToolSession,
  samplingProvider: ToolSessionSamplingProvider,
  afterLSN?: number,
): Operation<ToolExecution> {
  const subscription = yield* session.events(afterLSN);

  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      return sessionEventToExecution(runtimeId, call, session, null);
    }

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

    return sessionEventToExecution(runtimeId, call, session, next.value);
  }
}

export interface AgentCoreToolExecutionStrategyOptions {
  id?: string;
  registry: ToolSessionRegistry;
  samplingProvider: ToolSessionSamplingProvider;
  tools: AnyToolContract[];
}

export function createAgentCoreToolExecutionStrategy(
  options: AgentCoreToolExecutionStrategyOptions,
): ToolExecutionStrategy {
  const strategyId = options.id ?? "agentcore-session";
  const toolsByName = toolsByCanonicalName(options.tools, strategyId);
  return {
    id: strategyId,
    toolNames: Object.freeze([...toolsByName.keys()]),
    canExecute(entry, call) {
      return entry.definition.name === call.function.name && toolsByName.has(entry.definition.name);
    },
    *execute(entry, call, ctx: ToolExecutionContext): Operation<ToolExecution> {
      if (entry.definition.name !== call.function.name) {
        throw new ToolRuntimeError(
          "TOOL_CALL_ENTRY_MISMATCH",
          `Tool inventory entry "${entry.definition.name}" does not match call target "${call.function.name}"`,
        );
      }
      const tool = toolsByName.get(entry.definition.name);
      if (!tool) {
        throw new ToolRuntimeError(
          "NO_MATCHING_TOOL_STRATEGY",
          `AgentCore strategy cannot execute tool: ${entry.definition.name}`,
        );
      }
      const selectedModel = modelSelectionFromMetadata(ctx.metadata);
      const params = validateRuntimeToolParameters(tool, call.function.arguments, call.id);
      const session = yield* options.registry.create(tool, params, {
        sessionId: call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      });
      if (ctx.signal) {
        yield* spawn(function* () {
          yield* waitForAbort(ctx.signal!);
          yield* session.cancel("tool invocation cancelled");
        });
      }
      return yield* nextAgentCoreExecution(ctx.runtimeId, call, session, options.samplingProvider);
    },
    *resume(ref, input, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const sessionId = ref.sessionId ?? ref.executionId;
      const session = yield* options.registry.get(sessionId);
      if (!session) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `AgentCore tool session not found: ${sessionId}`,
        );
      }
      if (ref.toolName && session.toolName !== ref.toolName) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `AgentCore tool session not found: ${sessionId}`,
        );
      }
      const pendingId = input.type === "elicit_response" ? input.elicitId : undefined;
      const pendingLsn = yield* findPendingRequestLsn(session, pendingId);
      if (input.type === "elicit_response") {
        if (!input.elicitId) {
          throw new ToolRuntimeError("ELICIT_ID_REQUIRED", "Elicit continuation requires elicitId");
        }
        yield* session.respondToElicit(input.elicitId, input.result as WireElicitResult<unknown>);
      }
      if (ctx.signal) {
        yield* spawn(function* () {
          yield* waitForAbort(ctx.signal!);
          yield* session.cancel("tool invocation cancelled");
        });
      }
      return yield* nextAgentCoreExecution(
        ctx.runtimeId,
        {
          id: ref.callId,
          type: "function",
          function: { name: ref.toolName || session.toolName, arguments: {} },
        },
        session,
        options.samplingProvider,
        pendingLsn ?? afterLsnFromPendingId(pendingId),
      );
    },
    *abort(ref, reason): Operation<void> {
      const sessionId = ref.sessionId ?? ref.executionId;
      const session = yield* options.registry.get(sessionId);
      if (!session) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `AgentCore tool session not found: ${sessionId}`,
        );
      }
      yield* session.cancel(reason);
    },
  };
}

export function createAgentCoreToolRuntimeDriver(
  options: AgentCoreToolRuntimeDriverOptions,
): ToolRuntime {
  const runtimeId = options.id ?? "agentcore";
  const registry =
    options.registry ??
    (options.registryOptions
      ? createAgentCoreToolSessionRegistry(options.registryOptions)
      : undefined);
  if (!registry) {
    throw new Error("AgentCore tool runtime requires registry or registryOptions");
  }

  return createStrategyToolRuntime({
    id: runtimeId,
    strategies: [
      createAgentCoreToolExecutionStrategy({
        id: runtimeId,
        registry,
        samplingProvider: options.samplingProvider,
        tools: options.tools,
      }),
    ],
  });
}

export function* installAgentCoreToolRuntime(
  options: AgentCoreToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = createAgentCoreToolRuntimeDriver(options);
  yield* installToolRuntime(driver);
  return driver;
}
