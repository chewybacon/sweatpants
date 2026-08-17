import { assertJson, canonicalSnapshot } from "@sweatpants/foundation";
import type { Operation } from "effection";
import {
  ToolInvocationHostError,
  type ToolSession,
  type ToolSessionEvent,
  type ToolSessionRegistry,
  type StartToolInvocation,
  type ToolInvocationAsk,
  type ToolInvocationHost,
  type ToolInvocationHostErrorCode,
  type ToolInvocationId,
  type ToolInvocationTurn,
  type TurnToolInvocation,
} from "@sweatpants/tool-session";

interface CommandState {
  readonly digest: string;
  result?: ToolInvocationTurn;
}

interface InvocationEntry {
  readonly session: ToolSession;
  readonly startDigest: string;
  readonly commands: Map<string, CommandState>;
}

/**
 * Adapts the existing live ToolSession transport to the pull-based invocation
 * control plane. The registry and event stream stay behind this boundary. A
 * durable caller sees only start, turn, and dispose.
 */
export function createToolInvocationHost(registry: ToolSessionRegistry): ToolInvocationHost {
  const invocations = new Map<ToolInvocationId, InvocationEntry>();

  function hostError(code: ToolInvocationHostErrorCode, message: string): never {
    throw new ToolInvocationHostError(code, message);
  }

  function* requireInvocation(id: ToolInvocationId): Operation<InvocationEntry> {
    const existing = invocations.get(id);
    if (existing) {
      return existing;
    }

    const session = yield* registry.get(id);
    if (!session) {
      hostError("invocation_not_found", `Tool invocation "${id}" is not available`);
    }
    const entry: InvocationEntry = {
      session,
      startDigest: "rehydrated",
      commands: new Map(),
    };
    invocations.set(id, entry);
    return entry;
  }

  function startDigest(request: StartToolInvocation): string {
    return canonicalSnapshot(
      assertJson({
        invocationId: request.invocationId,
        tool: request.tool.name,
        input: request.input,
      }),
    ).sha;
  }

  function turnDigest(request: TurnToolInvocation): string {
    return canonicalSnapshot(
      assertJson({
        invocationId: request.invocationId,
        cursor: request.cursor,
        resume: request.resume ?? null,
      }),
    ).sha;
  }

  return {
    *start(request): Operation<void> {
      const digest = startDigest(request);
      const existing = invocations.get(request.invocationId);
      if (existing) {
        if (existing.startDigest !== digest) {
          hostError(
            "invocation_conflict",
            `Tool invocation "${request.invocationId}" was started with different input`,
          );
        }
        return;
      }

      const existingSession = yield* registry.get(request.invocationId);
      if (existingSession) {
        invocations.set(request.invocationId, {
          session: existingSession,
          startDigest: digest,
          commands: new Map(),
        });
        return;
      }

      const session = yield* registry.create(request.tool, request.input, {
        sessionId: request.invocationId,
      });
      invocations.set(request.invocationId, {
        session,
        startDigest: digest,
        commands: new Map(),
      });
    },

    *turn(request): Operation<ToolInvocationTurn> {
      const entry = yield* requireInvocation(request.invocationId);
      const digest = turnDigest(request);
      const existing = entry.commands.get(request.commandId);
      if (existing) {
        if (existing.digest !== digest) {
          hostError(
            "command_conflict",
            `Command "${request.commandId}" was retried with different input`,
          );
        }
        if (!existing.result) {
          hostError("command_in_progress", `Command "${request.commandId}" is still running`);
        }
        return existing.result;
      }

      const command: CommandState = { digest };
      entry.commands.set(request.commandId, command);
      try {
        if (request.resume) {
          yield* entry.session.resume(request.resume);
        }

        const result = yield* drainInvocation(entry.session, request.cursor);
        command.result = result;
        return result;
      } catch (error) {
        entry.commands.delete(request.commandId);
        throw error;
      }
    },

    *dispose(invocationId): Operation<void> {
      const entry = invocations.get(invocationId);
      if (!entry) {
        return;
      }
      invocations.delete(invocationId);
      yield* registry.release(entry.session.id);
    },
  };
}

function* drainInvocation(session: ToolSession, cursor: number): Operation<ToolInvocationTurn> {
  const events = yield* session.projection.events(cursor);
  while (true) {
    const next = yield* events.next();
    if (next.done) {
      return {
        type: "failed",
        error: {
          code: "invocation_ended_without_terminal",
          message: `Tool invocation "${session.id}" ended without a terminal event`,
          retryable: false,
        },
      };
    }

    const event = next.value;
    switch (event.type) {
      case "progress":
      case "log":
      case "sample_response_queued":
        // These records remain in the replayable projection for UX readers.
        // They do not park or terminate the control crank, so this drain keeps
        // pulling until it reaches an ask or terminal outcome.
        continue;
      case "sample_request":
        return { type: "parked", cursor: event.lsn, ask: sampleAsk(event) };
      case "elicit_request":
        return { type: "parked", cursor: event.lsn, ask: elicitAsk(event) };
      case "result":
        return { type: "completed", result: assertJson(event.result) };
      case "error":
        return {
          type: "failed",
          error: { code: "tool_invocation_failed", message: event.message, retryable: false },
        };
      case "cancelled":
        return {
          type: "cancelled",
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        };
    }
  }
}

function sampleAsk(
  event: Extract<ToolSessionEvent, { type: "sample_request" }>,
): ToolInvocationAsk {
  return {
    kind: "sample",
    requestId: event.sampleId,
    messages: event.messages,
    ...(event.systemPrompt === undefined ? {} : { systemPrompt: event.systemPrompt }),
    ...(event.maxTokens === undefined ? {} : { maxTokens: event.maxTokens }),
    ...(event.modelPreferences === undefined ? {} : { modelPreferences: event.modelPreferences }),
    ...(event.tools === undefined ? {} : { tools: event.tools }),
    ...(event.toolChoice === undefined ? {} : { toolChoice: event.toolChoice }),
    ...(event.schema === undefined ? {} : { schema: event.schema }),
  };
}

function elicitAsk(
  event: Extract<ToolSessionEvent, { type: "elicit_request" }>,
): ToolInvocationAsk {
  return {
    kind: "elicit",
    requestId: event.elicitId,
    key: event.key,
    message: event.message,
    schema: event.schema,
    ...(event.context === undefined ? {} : { context: event.context }),
    ...(event.bindingId === undefined ? {} : { bindingId: event.bindingId }),
    ...(event.ownerInterfaceDigest === undefined
      ? {}
      : { ownerInterfaceDigest: event.ownerInterfaceDigest }),
    ...(event.responseContract === undefined
      ? {}
      : { responseContract: assertJson(event.responseContract) }),
    ...(event.contextContract === undefined
      ? {}
      : { contextContract: assertJson(event.contextContract) }),
  };
}
