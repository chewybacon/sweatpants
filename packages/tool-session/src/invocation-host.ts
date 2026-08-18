import { canonicalSnapshot } from "@sweatpants/foundation";
import { action, spawn, type Operation, type Task } from "effection";
import type { ToolSessionEvent } from "./contract.ts";
import {
  ToolInvocationHostError,
  type ToolInvocationResource,
  type ToolInvocationResourceFactory,
  type StartToolInvocation,
  type ToolInvocationAsk,
  type ToolInvocationHost,
  type ToolInvocationHostErrorCode,
  type ToolInvocationId,
  type ToolInvocationTurn,
  type TurnToolInvocation,
} from "./invocation.ts";

type CommandOutcome =
  | { readonly type: "result"; readonly value: ToolInvocationTurn }
  | { readonly type: "error"; readonly error: unknown };

interface CommandState {
  readonly digest: string;
  outcome?: CommandOutcome;
  readonly waiters: Set<(outcome: CommandOutcome) => void>;
}

interface ActiveCommand {
  readonly command: CommandState;
  readonly task: Task<void>;
}

interface InvocationEntry {
  readonly resource: ToolInvocationResource;
  readonly startDigest: string;
  readonly commands: Map<string, CommandState>;
  active: ActiveCommand | undefined;
}

/**
 * Adapts the existing live ToolSession transport to the pull-based invocation
 * control plane. The registry and event stream stay behind this boundary. A
 * durable caller sees only start, turn, and dispose.
 */
export function createToolInvocationHost(
  factory: ToolInvocationResourceFactory,
): ToolInvocationHost {
  const invocations = new Map<ToolInvocationId, InvocationEntry>();

  function hostError(code: ToolInvocationHostErrorCode, message: string): never {
    throw new ToolInvocationHostError(code, message);
  }

  function* requireInvocation(id: ToolInvocationId): Operation<InvocationEntry> {
    const existing = invocations.get(id);
    if (existing) {
      return existing;
    }

    const resource = yield* factory.open(id);
    if (!resource) {
      hostError("invocation_not_found", `Tool invocation "${id}" is not available`);
    }
    const entry: InvocationEntry = {
      resource,
      startDigest: "rehydrated",
      commands: new Map(),
      active: undefined,
    };
    invocations.set(id, entry);
    return entry;
  }

  function startDigest(request: StartToolInvocation): string {
    return canonicalSnapshot({
      invocationId: request.invocationId,
      tool: request.tool.name,
      input: request.input,
      model: request.model ?? null,
    }).sha;
  }

  function settleCommand(command: CommandState, outcome: CommandOutcome): void {
    command.outcome = outcome;
    for (const resolve of command.waiters) {
      resolve(outcome);
    }
    command.waiters.clear();
  }

  function* waitForCommand(command: CommandState): Operation<ToolInvocationTurn> {
    let outcome = command.outcome;
    if (!outcome) {
      outcome = yield* action<CommandOutcome>((resolve) => {
        command.waiters.add(resolve);
        return () => command.waiters.delete(resolve);
      });
    }
    if (outcome.type === "error") {
      throw outcome.error;
    }
    return outcome.value;
  }

  function turnDigest(request: TurnToolInvocation): string {
    return canonicalSnapshot({
      invocationId: request.invocationId,
      cursor: request.cursor,
      resume: request.resume ?? null,
    }).sha;
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

      const existingResource = yield* factory.open(request.invocationId);
      if (existingResource) {
        invocations.set(request.invocationId, {
          resource: existingResource,
          startDigest: digest,
          commands: new Map(),
          active: undefined,
        });
        return;
      }

      const resource = yield* factory.create(request);
      invocations.set(request.invocationId, {
        resource,
        startDigest: digest,
        commands: new Map(),
        active: undefined,
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
        return yield* waitForCommand(existing);
      }

      if (entry.active) {
        hostError(
          "command_in_progress",
          `Tool invocation "${request.invocationId}" already has an active command`,
        );
      }

      const command: CommandState = { digest, waiters: new Set() };
      entry.commands.set(request.commandId, command);
      const task = yield* spawn(function* activeInvocationCommand() {
        try {
          if (request.resume) {
            yield* entry.resource.resume(request.resume);
          }

          const result = yield* drainInvocation(entry.resource, request.cursor);
          settleCommand(command, { type: "result", value: result });
        } catch (error) {
          settleCommand(command, { type: "error", error });
        } finally {
          if (entry.active?.command === command) {
            entry.active = undefined;
          }
        }
      });
      entry.active = { command, task };
      if (command.outcome) {
        entry.active = undefined;
      }
      return yield* waitForCommand(command);
    },

    *dispose(invocationId): Operation<void> {
      const entry = invocations.get(invocationId);
      if (!entry) {
        return;
      }
      invocations.delete(invocationId);
      const active = entry.active;
      if (active) {
        yield* active.task.halt();
        entry.active = undefined;
      }
      yield* entry.resource.dispose();
      if (active) {
        const error = new ToolInvocationHostError(
          "command_in_progress",
          `Active command for tool invocation "${invocationId}" was aborted`,
        );
        settleCommand(active.command, { type: "error", error });
      }
    },
  };
}

function* drainInvocation(
  resource: ToolInvocationResource,
  cursor: number,
): Operation<ToolInvocationTurn> {
  const events = yield* resource.projection.events(cursor);
  while (true) {
    const next = yield* events.next();
    if (next.done) {
      return {
        type: "failed",
        error: {
          code: "invocation_ended_without_terminal",
          message: `Tool invocation "${resource.id}" ended without a terminal event`,
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
        return { type: "completed", result: event.result };
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
    ...(event.responseContract === undefined ? {} : { responseContract: event.responseContract }),
    ...(event.contextContract === undefined ? {} : { contextContract: event.contextContract }),
  };
}
