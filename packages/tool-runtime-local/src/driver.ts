import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { action, resource, spawn, type Operation, type Stream } from "effection";
import {
  installToolRuntime,
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  validateRuntimeToolParameters,
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
  ToolSessionStore,
} from "@sweatpants/tool-session";
import { createInMemoryToolSessionStore } from "./in-memory-store.ts";
import {
  createToolSessionRegistry,
  isWorkerBackedToolSessionRegistry,
  type ToolSessionRegistryOptions,
} from "./session-registry.ts";

export interface LocalToolRuntimeDriverOptions {
  id?: string;
  tools: AnyToolContract[];
  registry?: ToolSessionRegistry;
  store?: ToolSessionStore;
  samplingProvider?: ToolSessionSamplingProvider;
  registryOptions?: ToolSessionRegistryOptions;
}

function localRuntimeWorkerRequirementError(): ToolRuntimeError {
  return new ToolRuntimeError(
    "WORKER_BACKED_LOCAL_RUNTIME_REQUIRED",
    "Local tool runtime requires a worker-backed ToolSessionRegistry. " +
      "Pass registryOptions.worker when creating the runtime or supply a registry created with worker mode enabled.",
  );
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

function afterLsnFromElicitId(elicitId: string | undefined): number | undefined {
  if (!elicitId) {
    return undefined;
  }
  const requestMatch = /:req:(\d+)$/.exec(elicitId);
  return requestMatch?.[1] ? Number(requestMatch[1]) : undefined;
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
    if (next.done) {
      return mcpEventToExecution(runtimeId, call, session, null);
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

    return mcpEventToExecution(runtimeId, call, session, next.value);
  }
}

export interface LocalSessionToolExecutionStrategyOptions {
  id?: string;
  registry: ToolSessionRegistry;
  samplingProvider: ToolSessionSamplingProvider;
  tools: AnyToolContract[];
}

export function createLocalSessionToolExecutionStrategy(
  options: LocalSessionToolExecutionStrategyOptions,
): ToolExecutionStrategy {
  const strategyId = options.id ?? "local-session";
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
          `Local session strategy cannot execute tool: ${entry.definition.name}`,
        );
      }
      const params = validateRuntimeToolParameters(tool, call.function.arguments, call.id);
      const session = yield* options.registry.create(tool, params, {
        sessionId: call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (ctx.signal) {
        yield* spawn(function* () {
          yield* waitForAbort(ctx.signal!);
          yield* session.cancel("tool invocation cancelled");
        });
      }
      return yield* nextMcpExecution(ctx.runtimeId, call, session, options.samplingProvider);
    },
    *resume(ref, input, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const sessionId = ref.sessionId ?? ref.executionId;
      const session = yield* options.registry.get(sessionId);
      if (!session) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      }
      if (ref.toolName && session.toolName !== ref.toolName) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      }
      if (!input.elicitId) {
        throw new ToolRuntimeError("ELICIT_ID_REQUIRED", "Elicit continuation requires elicitId");
      }
      yield* session.respondToElicit(input.elicitId, input.result as WireElicitResult<unknown>);
      if (ctx.signal) {
        yield* spawn(function* () {
          yield* waitForAbort(ctx.signal!);
          yield* session.cancel("tool invocation cancelled");
        });
      }
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
      if (!session) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool session not found: ${sessionId}`,
        );
      }
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

  if (options.registry) {
    if (!isWorkerBackedToolSessionRegistry(options.registry)) {
      throw localRuntimeWorkerRequirementError();
    }
  } else if (!options.registryOptions?.worker) {
    throw localRuntimeWorkerRequirementError();
  }

  const registry =
    options.registry ??
    (yield* createToolSessionRegistry(
      options.store ?? createInMemoryToolSessionStore(),
      options.registryOptions ?? {},
    ));

  return createStrategyToolRuntime({
    id: runtimeId,
    strategies: [
      createLocalSessionToolExecutionStrategy({
        id: runtimeId,
        registry,
        samplingProvider,
        tools: options.tools,
      }),
    ],
  });
}

export function* installLocalToolRuntime(
  options: LocalToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = yield* createLocalToolRuntimeDriver(options);
  yield* installToolRuntime(driver);
  return driver;
}
