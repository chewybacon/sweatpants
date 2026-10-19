import { advanceToolInvocation, type ToolInvocationBoundary } from "../invocation-executor.ts";
import { parseRuntimeToolParameters, requireToolParameterResult } from "../tool-parameters.ts";
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
  modelSelectionFromMetadata,
  ToolInvocationHostPort,
  type ToolInvocationHost,
  type ToolSessionSamplingProvider,
  type TurnToolInvocation,
} from "../index.ts";

export interface InvocationToolRuntimeDriverOptions {
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
): Operation<ToolInvocationBoundary> {
  if (!signal) {
    return yield* advanceToolInvocation(host, request);
  }
  return yield* race([
    advanceToolInvocation(host, request),
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
  initialTurn: ToolInvocationBoundary,
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
      /* CONDITIONAL-SPREAD: The cursor fields belong only to the currentTurn.kind === "suspended" variant. */
      ...(currentTurn.kind === "suspended" ? { cursor: currentTurn.request.cursor } : {}),
    });
    if (currentTurn.kind === "completed") {
      return { kind: "completed", ref, result: currentTurn.value };
    }
    if (currentTurn.kind === "failed") {
      return {
        kind: "failed",
        ref,
        error: { code: currentTurn.error.code, message: currentTurn.error.message },
      };
    }
    if (currentTurn.kind === "cancelled") {
      return {
        kind: "failed",
        ref,
        error: {
          code: "TOOL_CANCELLED",
          message: currentTurn.reason ?? "Tool execution was cancelled",
        },
      };
    }
    if (currentTurn.kind === "suspended") {
      if (currentTurn.request.kind === "elicit") {
        const ask = currentTurn.request;
        return {
          kind: "awaiting_elicit",
          ref,
          request: {
            elicitId: ask.requestId,
            key: ask.key,
            message: ask.message,
            schema: ask.schema,
            /* CONDITIONAL-SPREAD: Omit absent context from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
            ...(ask.context !== undefined ? { context: ask.context } : {}),
            binding: ask.binding,
          },
        };
      }
      if (currentTurn.request.kind === "sample") {
        const ask = currentTurn.request;
        const result = yield* samplingProvider.sample([...ask.messages], {
          systemPrompt: ask.systemPrompt,
          maxTokens: ask.maxTokens,
          tools: ask.tools?.slice(),
          toolChoice: ask.toolChoice,
          schema: ask.schema,
        });
        currentTurn = yield* advanceToolInvocation(host, {
          invocationId: call.id,
          commandId: `sample:${ask.requestId}`,
          cursor: currentTurn.request.cursor,
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

export interface InvocationToolExecutionStrategyOptions {
  id?: string;
  samplingProvider: ToolSessionSamplingProvider;
  tools: AnyToolContract[];
}

export function createInvocationToolExecutionStrategy(
  options: InvocationToolExecutionStrategyOptions,
): ToolExecutionStrategy {
  const strategyId = options.id ?? "tool-session";
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
          `Invocation strategy cannot execute tool: ${entry.definition.name}`,
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
        model: modelSelectionFromMetadata(ctx.metadata),
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
          `Tool invocation not found: ${invocationId}`,
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
            /* CONDITIONAL-SPREAD: Omit absent reason from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
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

export function* createInvocationToolRuntimeDriver(
  options: InvocationToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const runtimeId = options.id ?? "tool-session";
  const samplingProvider = options.samplingProvider ?? {
    *sample() {
      throw new Error("Tool invocation sampling provider not configured");
    },
  };

  return createStrategyToolRuntime({
    id: runtimeId,
    strategies: [
      createInvocationToolExecutionStrategy({
        id: runtimeId,
        samplingProvider,
        tools: options.tools,
      }),
    ],
  });
}

export function* installInvocationToolRuntime(
  options: InvocationToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = yield* createInvocationToolRuntimeDriver(options);
  yield* installToolRuntime(driver);
  return driver;
}
