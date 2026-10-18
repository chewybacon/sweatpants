import { readMcpRequestMetadata, requireMcpFormCapability } from "@sweatpants/tool-session/mcp";
import { createMcpContinuations, decodeMcpFormResponse } from "@sweatpants/tool-session/mcp";
import type { Operation } from "effection";
import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import type { AdvancementResult } from "@sweatpants/durable-execution";
import type { AuthorityScenarioDriver } from "@sweatpants/journal-authority/testing";
import { PickCardContextSchema, pickCard } from "../../src/tools/pick-card/durable.ts";

/** Research fixture for MCP 2026-07-28 MRTR; not a production MCP endpoint. */
export interface TracerRequest {
  jsonrpc: "2.0";
  id: string;
  method: "tools/call";
  params: {
    name: string;
    arguments: Json;
    requestState?: string;
    inputResponses?: unknown;
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28";
      "io.modelcontextprotocol/clientCapabilities": Record<string, unknown>;
    };
  };
}

export function createPickCardMcpTracer(options: {
  authority: AuthorityScenarioDriver;
  sessionId: string;
  taskId: string;
  callerId: string;
  arguments: Json;
  secret: string;
  now: () => number;
  advance: () => Operation<AdvancementResult>;
}) {
  const { authority, sessionId, taskId } = options;
  const binding = canonicalJson({
    callerId: options.callerId,
    sessionId,
    taskId,
    method: "tools/call",
    name: pickCard.name,
    arguments: options.arguments,
  });
  const continuations = createMcpContinuations({
    secret: options.secret,
    ttlMs: 60_000,
    now: options.now,
  });
  const requestBinding = (request: TracerRequest, callerId: string) => ({
    serverId: "pick-card-tracer",
    callerId,
    method: request.method,
    params: { name: request.params.name, arguments: request.params.arguments },
  });

  return function* call(
    request: TracerRequest,
    callerId: string,
    headers: Headers,
  ): Operation<{
    jsonrpc: "2.0";
    id: string;
    result: Record<string, unknown>;
  }> {
    const metadata = readMcpRequestMetadata({
      headers,
      method: request.method,
      params: request.params,
      protocolVersion: "2026-07-28",
    });
    requireMcpFormCapability(metadata.capabilities);
    if (
      canonicalJson({
        callerId,
        sessionId,
        taskId,
        method: request.method,
        name: request.params.name,
        arguments: request.params.arguments,
      }) !== binding
    ) {
      throw new Error("Continuation request binding mismatch");
    }
    const continuation = request.params.requestState;
    if (continuation !== undefined) {
      const state = yield* continuations.verify(continuation, requestBinding(request, callerId));
      if (state.invocationId !== sessionId) {
        throw new Error("Continuation invocation mismatch");
      }
      const response = decodeMcpFormResponse(request.params.inputResponses, state.pullId);
      const operation = yield* authority.operationState(sessionId, taskId, state.pullId);
      if (operation.status !== "found" || operation.descriptor.kind !== "elicit") {
        throw new Error("Unknown pending pull");
      }
      const cards = PickCardContextSchema.parse(operation.descriptor.context).cards;
      const picked =
        response.action === "accept"
          ? cards.find((card) => card.display === response.content?.picked)
          : undefined;
      if (response.action === "accept" && !picked) {
        throw new Error("Selected card was not offered");
      }
      const completion = assertJson(
        response.action === "accept"
          ? { action: "accept", content: { picked } }
          : { action: response.action },
      );
      if (operation.outcome) {
        if (
          canonicalJson(operation.outcome) !== canonicalJson({ status: "ok", value: completion })
        ) {
          throw new Error("Conflicting duplicate input response");
        }
      } else {
        const validated = yield* authority.validateElicitResponse({
          sessionId,
          pullId: state.pullId,
          participantId: "user:pickCard",
          completion,
        });
        if (validated.status !== "valid") {
          throw new Error(`Invalid input: ${validated.status}`);
        }
        const resolution = yield* authority.resolve({
          capability: authority.resolutionCapability(sessionId, taskId, state.pullId),
          audience: validated.audience,
          outcome: validated.outcome,
        });
        if (resolution.status === "rejected") {
          throw new Error(`Rejected input: ${resolution.code}`);
        }
      }
    } else if (request.params.inputResponses !== undefined) {
      throw new Error("Input responses require a continuation");
    }

    const recovered = yield* authority.taskRecoveryState(sessionId, taskId);
    if (recovered.status === "terminal") {
      if (recovered.outcome.status !== "ok") {
        throw new Error("Tool failed");
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: recovered.outcome.value }],
        },
      };
    }
    const next = yield* options.advance();
    if (next.state === "completed") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: next.value }],
        },
      };
    }
    if (next.state !== "parked") {
      throw new Error(`Unexpected state: ${next.state}`);
    }
    const pending = yield* authority.operationState(sessionId, taskId, next.pullId);
    if (pending.status !== "found" || pending.descriptor.kind !== "elicit") {
      throw new Error("Expected an elicitation park");
    }
    const cards = PickCardContextSchema.parse(pending.descriptor.context).cards;
    const requestState = yield* continuations.issue(requestBinding(request, callerId), {
      invocationId: sessionId,
      pullId: next.pullId,
    });
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        resultType: "input_required",
        inputRequests: {
          [next.pullId]: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: pending.descriptor.message,
              requestedSchema: {
                type: "object",
                properties: { picked: { type: "string", enum: cards.map((card) => card.display) } },
                required: ["picked"],
              },
            },
          },
        },
        requestState,
      },
    };
  };
}
