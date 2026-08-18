import {
  parseRuntimeToolParameters,
  requireToolParameterResult,
} from "@sweatpants/tool-session/tool-parameters";
import type { Json } from "@sweatpants/foundation";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { ChatToolCall } from "@sweatpants/chat-contract";
import { action, race, type Operation } from "effection";
import {
  installToolRuntime,
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionStrategy,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";
import {
  ToolInvocationHostError,
  ToolInvocationHostPort,
  type ToolInvocationHost,
  type ToolInvocationTurn,
  type ToolSessionSamplingProvider,
  type TurnToolInvocation,
} from "@sweatpants/tool-session";

export interface LocalToolRuntimeDriverOptions {
  id?: string;
  tools: AnyToolContract[];
  samplingProvider?: ToolSessionSamplingProvider;
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

function* turnWithActiveAbort(
  host: ToolInvocationHost,
  request: TurnToolInvocation,
  signal: AbortSignal | undefined,
): Operation<ToolInvocationTurn> {
  if (!signal) {
    return yield* host.turn(request);
  }
  return yield* race([
    host.turn(request),
    (function* abortActiveTurn() {
      yield* waitForAbort(signal);
      yield* host.dispose(request.invocationId);
      throw new ToolRuntimeError("TOOL_ABORTED", "Active tool execution was aborted");
    })(),
  ]);
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

function* runInvocationTurnLoop(
  host: ToolInvocationHost,
  runtimeId: string,
  call: ChatToolCall,
  initialTurn: ToolInvocationTurn,
  samplingProvider: ToolSessionSamplingProvider,
): Operation<ToolExecution> {
  let currentTurn = initialTurn;
  while (true) {
    const ref = createToolExecutionRef({
      runtimeId,
      executionId: call.id,
      sessionId: call.id,
      callId: call.id,
      toolName: call.name,
      ...(currentTurn.type === "parked" ? { cursor: currentTurn.cursor } : {}),
    });
    if (currentTurn.type === "completed") {
      return { kind: "completed", ref, result: currentTurn.result };
    }
    if (currentTurn.type === "failed") {
      return {
        kind: "failed",
        ref,
        error: { code: currentTurn.error.code, message: currentTurn.error.message },
      };
    }
    if (currentTurn.type === "cancelled") {
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_CANCELLED",
          message: currentTurn.reason ?? "Tool execution was cancelled",
        },
      };
    }
    if (currentTurn.type === "parked") {
      if (currentTurn.ask.kind === "elicit") {
        const ask = currentTurn.ask;
        return {
          kind: "awaiting_elicit",
          ref,
          request: {
            elicitId: ask.requestId,
            key: ask.key,
            message: ask.message,
            schema: ask.schema,
            ...(ask.context !== undefined ? { context: ask.context } : {}),
            ...(ask.bindingId !== undefined ? { bindingId: ask.bindingId } : {}),
            ...(ask.responseContract !== undefined
              ? { responseContract: ask.responseContract }
              : {}),
            ...(ask.contextContract !== undefined ? { contextContract: ask.contextContract } : {}),
            ...(ask.ownerInterfaceDigest !== undefined
              ? { ownerInterfaceDigest: ask.ownerInterfaceDigest }
              : {}),
          },
        };
      }
      if (currentTurn.ask.kind === "sample") {
        const ask = currentTurn.ask;
        const result = yield* samplingProvider.sample([...ask.messages], {
          ...(ask.systemPrompt !== undefined ? { systemPrompt: ask.systemPrompt } : {}),
          ...(ask.maxTokens !== undefined ? { maxTokens: ask.maxTokens } : {}),
          ...(ask.tools !== undefined ? { tools: [...ask.tools] } : {}),
          ...(ask.toolChoice !== undefined ? { toolChoice: ask.toolChoice } : {}),
          ...(ask.schema !== undefined ? { schema: ask.schema } : {}),
        });
        currentTurn = yield* host.turn({
          invocationId: call.id,
          commandId: `sample:${ask.requestId}`,
          cursor: currentTurn.cursor,
          resume: {
            kind: "sample",
            requestId: ask.requestId,
            response: result,
          },
        });
        continue;
      }
    }
  }
}

export interface LocalSessionToolExecutionStrategyOptions {
  id?: string;
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
      return entry.definition.name === call.name && toolsByName.has(entry.definition.name);
    },
    *execute(entry, call, ctx: ToolExecutionContext): Operation<ToolExecution> {
      if (entry.definition.name !== call.name) {
        throw new ToolRuntimeError(
          "TOOL_CALL_ENTRY_MISMATCH",
          `Tool inventory entry "${entry.definition.name}" does not match call target "${call.name}"`,
        );
      }
      const tool = toolsByName.get(entry.definition.name);
      if (!tool) {
        throw new ToolRuntimeError(
          "NO_MATCHING_TOOL_STRATEGY",
          `Local session strategy cannot execute tool: ${entry.definition.name}`,
        );
      }
      const params = requireToolParameterResult(
        parseRuntimeToolParameters<Json>(tool, call.input, call.id),
        { toolName: tool.name, callId: call.id },
      );

      const host = yield* ToolInvocationHostPort.use();
      yield* host.start({
        invocationId: call.id,
        tool,
        input: params,
      });

      const initialTurn = yield* turnWithActiveAbort(
        host,
        {
          invocationId: call.id,
          commandId: `call:${call.id}:start`,
          cursor: 0,
        },
        ctx.signal,
      );

      return yield* runInvocationTurnLoop(
        host,
        ctx.runtimeId,
        call,
        initialTurn,
        options.samplingProvider,
      );
    },
    *resume(ref, input, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const invocationId = ref.sessionId ?? ref.executionId;
      if (!toolsByName.has(ref.toolName)) {
        throw new ToolRuntimeError(
          "EXECUTION_NOT_FOUND",
          `Local tool invocation not found: ${invocationId}`,
        );
      }
      if (!input.elicitId) {
        throw new ToolRuntimeError("ELICIT_ID_REQUIRED", "Elicit continuation requires elicitId");
      }

      const host = yield* ToolInvocationHostPort.use();
      const turn = yield* turnWithActiveAbort(
        host,
        {
          invocationId,
          commandId: `elicit:${input.elicitId}`,
          cursor: ref.cursor ?? 0,
          resume: {
            kind: "elicit",
            requestId: input.elicitId,
            response: input.completion,
          },
        },
        ctx.signal,
      );

      return yield* runInvocationTurnLoop(
        host,
        ctx.runtimeId,
        {
          id: ref.callId,
          name: ref.toolName,
          input: {},
          thoughtSignature: null,
        },
        turn,
        options.samplingProvider,
      );
    },
    *abort(ref, reason): Operation<void> {
      const invocationId = ref.sessionId ?? ref.executionId;
      const host = yield* ToolInvocationHostPort.use();
      try {
        yield* host.turn({
          invocationId,
          commandId: `abort:${invocationId}`,
          cursor: ref.cursor ?? 0,
          resume: {
            kind: "cancel",
            ...(reason === undefined ? {} : { reason }),
          },
        });
      } catch (error) {
        if (!(error instanceof ToolInvocationHostError) || error.code !== "command_in_progress") {
          throw error;
        }
      } finally {
        yield* host.dispose(invocationId);
      }
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

  return createStrategyToolRuntime({
    id: runtimeId,
    strategies: [
      createLocalSessionToolExecutionStrategy({
        id: runtimeId,
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
