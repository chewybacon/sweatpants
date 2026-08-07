/**
 * In-Memory Tool Session Implementation
 *
 * Wraps the bridge-runtime to provide a durable session interface.
 * The session survives across HTTP request boundaries, enabling multi-step
 * elicitation flows.
 *
 * Architecture:
 * - Session is created and tool execution starts immediately (spawned)
 * - Event-log semantics (LSN, status, replay, settlement) come from the shared
 *   `createToolSessionEventLog` kernel in @sweatpants/tool-session
 * - Events: elicit_request, sample_request, result, error, cancelled
 * - For elicits: consumer returns to client, client responds, new request calls `respondToElicit()` then continues the stream
 * - For samples: consumer handles inline (calls LLM), then calls `respondToSample()` and continues the stream
 *
 * @packageDocumentation
 */
import { type Operation, type Signal, type Stream, spawn, resource, each } from "effection";
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  ToolSessionOptions,
} from "@sweatpants/tool-session";
import type {
  ElicitsMap,
  SamplesMap,
  ToolDefinition,
  ElicitExchangeCompletion,
  SampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
import {
  parseToolParameters,
  requireToolParameterResult,
} from "@sweatpants/tool-session/tool-parameters";
import { createBridgeHost, type ElicitId, type ElicitResponse } from "@sweatpants/tool-session/mcp";
import { createToolSessionEventLog, isTerminalToolSessionStatus } from "@sweatpants/tool-session";

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * Pending elicit - stores the signal for responding.
 */
interface PendingElicit {
  id: string;
  elicitRequestId: ElicitId;
  signal: Signal<ElicitResponse, void>;
}

/**
 * Pending sample - stores the signal for responding.
 */
interface LocalSampleResponse {
  completion: SampleExchangeCompletion;
}

interface PendingSample {
  id: string;
  signal: Signal<LocalSampleResponse, void>;
}

// =============================================================================
// TOOL SESSION IMPLEMENTATION
// =============================================================================

/**
 * Create an in-memory tool session.
 *
 * This is a resource that:
 * 1. Spawns the tool execution immediately
 * 2. Events are appended to the shared event log as they happen
 * 3. `events()` returns a replayable stream over that log
 * 4. For samples/elicits, the consumer responds and continues iterating
 *
 * @param tool - The tool to execute
 * @param params - Tool parameters
 * @param options - Session options
 */
export function createToolSession<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined = undefined,
>(
  tool: ToolDefinition<TName, TParams, TResult, TElicits, TSamples>,
  params: TParams,
  options: ToolSessionOptions = {},
): Operation<ToolSession<TResult>> {
  return resource<ToolSession<TResult>>(function* (provide) {
    const sessionId = options.sessionId ?? generateSessionId();
    const invocationController = new AbortController();
    const invocationSignal = options.signal
      ? AbortSignal.any([options.signal, invocationController.signal])
      : invocationController.signal;

    const log = createToolSessionEventLog<TResult>();
    let pendingElicit: PendingElicit | null = null;
    let pendingSample: PendingSample | null = null;

    const validatedParams = requireToolParameterResult(
      parseToolParameters<TParams>({
        schema: tool.parameters,
        params,
        toolName: tool.name,
        callId: sessionId,
      }),
      { toolName: tool.name, callId: sessionId },
    );

    // Create the bridge host
    const hostConfig = {
      tool,
      params: validatedParams,
      callId: sessionId,
      signal: invocationSignal,
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    };
    const host = createBridgeHost(hostConfig);

    // Start tool execution immediately - this runs in the session's scope
    log.setStatus("running");

    // Spawn event processor - converts bridge events to session events
    yield* spawn(function* () {
      for (const event of yield* each(host.events)) {
        switch (event.type) {
          case "elicit": {
            const elicitId = `${sessionId}:req:${log.peekNextLsn()}`;
            pendingElicit = {
              id: elicitId,
              elicitRequestId: event.request.id,
              signal: event.responseSignal,
            };
            log.append({
              type: "elicit_request",
              elicitId,
              key: event.request.key,
              message: event.request.message,
              schema: event.request.schema.json,
              ...(event.request.context !== undefined ? { context: event.request.context } : {}),
            });
            break;
          }

          case "sample": {
            const sampleId = `${sessionId}:req:${log.peekNextLsn()}`;
            pendingSample = { id: sampleId, signal: event.responseSignal };
            log.append({
              type: "sample_request",
              sampleId,
              messages: event.messages,
              systemPrompt: event.options?.systemPrompt,
              maxTokens: event.options?.maxTokens,
              tools: event.options?.tools,
              toolChoice: event.options?.toolChoice,
              schema: event.options?.schema,
            });
            break;
          }

          case "log":
            log.append({ type: "log", level: event.level, message: event.message });
            break;

          case "notify":
            log.append({ type: "progress", message: event.message, progress: event.progress });
            break;
        }
        yield* each.next();
      }
    });

    // Spawn tool runner
    yield* spawn(function* () {
      try {
        const result = yield* host.run();
        if (!isTerminalToolSessionStatus(log.status)) {
          log.append({ type: "result", result });
        }
      } catch (error) {
        // Cancellation aborts host.run(); the terminal `cancelled` event was
        // already appended by cancel() and must not be overwritten by the
        // abort-induced error.
        if (!isTerminalToolSessionStatus(log.status)) {
          log.append({
            type: "error",
            name: (error as Error).name,
            message: (error as Error).message,
            stack: (error as Error).stack,
          });
        }
      } finally {
        log.close();
      }
    });

    // Create the session interface
    const session: ToolSession<TResult> = {
      id: sessionId,
      toolName: tool.name,

      *status(): Operation<ToolSessionStatus> {
        return log.status;
      },

      settled: () => log.settled(),

      events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
        return log.events(afterLSN);
      },

      *respondToElicit(
        elicitId: string,
        response: ElicitExchangeCompletion<unknown>,
      ): Operation<void> {
        const pending = pendingElicit;
        if (!pending) {
          return;
        }
        if (pending.id !== elicitId) {
          throw new Error(`Elicitation ID mismatch: expected ${pending.id}, got ${elicitId}`);
        }

        // Send response via the bridge's signal - this unblocks the tool execution
        pendingElicit = null;
        log.setStatus("running");
        pending.signal.send({ id: pending.elicitRequestId, completion: response });
      },

      *respondToSample(sampleId: string, response: SampleExchangeCompletion): Operation<void> {
        const pending = pendingSample;
        if (!pending) {
          return;
        }
        if (pending.id !== sampleId) {
          throw new Error(`Sample ID mismatch: expected ${pending.id}, got ${sampleId}`);
        }

        // Send response via the bridge's signal
        pendingSample = null;
        log.setStatus("running");
        pending.signal.send({ completion: response });
      },

      *emitWakeUp(): Operation<void> {
        // No longer needed
      },

      *cancel(reason?: string): Operation<void> {
        if (isTerminalToolSessionStatus(log.status)) {
          return;
        }
        invocationController.abort("tool invocation cancelled");
        log.append({ type: "cancelled", reason });
        log.close();
      },
    };

    try {
      yield* provide(session);
    } finally {
      if (!invocationController.signal.aborted) {
        invocationController.abort("tool invocation scope exited");
      }
    }
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
