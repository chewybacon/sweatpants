import { run, type Operation, type Task } from "effection";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import {
  type ClientElicitBinding,
  type PluginRegistry,
  type RawClientElicit,
  type ElicitHandlerInput,
  type ElicitHandlerMetadata,
} from "./plugin.ts";

export type ClientDiagnosticCode =
  | "client_elicit_binding_missing"
  | "client_elicit_binding_mismatch"
  | "client_elicit_context_missing"
  | "client_elicit_context_unexpected"
  | "client_elicit_context_invalid"
  | "client_elicit_handler_failed";

export class ClientElicitDiagnostic extends Error {
  constructor(
    readonly code: ClientDiagnosticCode,
    message: string,
    readonly elicitId: string,
  ) {
    super(message);
    this.name = "ClientElicitDiagnostic";
  }
}

function descriptorMatches(
  actual: { identity: string; digest: string } | undefined,
  expected: { identity: string; digest: string } | undefined,
): boolean {
  if (actual === undefined || expected === undefined) {
    return actual === expected;
  }
  return actual.identity === expected.identity && actual.digest === expected.digest;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Validate a raw request once and invoke exactly the matched authored handler.
 * This function has no framework knowledge and carries open accepted content
 * unchanged to its caller.
 */
export function* executeClientElicitHandler<TCapabilities>(
  binding: ClientElicitBinding<unknown, TCapabilities>,
  request: RawClientElicit,
  capabilities: TCapabilities,
): Operation<ElicitExchangeCompletion<unknown>> {
  if (
    binding.binding.id !== request.bindingId ||
    binding.toolName !== request.toolName ||
    binding.key !== request.key ||
    !descriptorMatches(binding.responseContract, request.responseContract) ||
    !descriptorMatches(binding.contextContract, request.contextContract)
  ) {
    throw new ClientElicitDiagnostic(
      "client_elicit_binding_mismatch",
      `Client binding evidence does not match elicitation "${request.elicitId}"`,
      request.elicitId,
    );
  }

  const declaredContext = binding.contextSchema !== undefined;
  const suppliedContext = hasOwn(request, "context");
  if (declaredContext && !suppliedContext) {
    throw new ClientElicitDiagnostic(
      "client_elicit_context_missing",
      `Elicitation "${request.elicitId}" requires context`,
      request.elicitId,
    );
  }
  if (!declaredContext && suppliedContext) {
    throw new ClientElicitDiagnostic(
      "client_elicit_context_unexpected",
      `Elicitation "${request.elicitId}" does not declare context`,
      request.elicitId,
    );
  }

  let context: unknown;
  if (declaredContext) {
    try {
      const contextSchema = binding.contextSchema;
      if (!contextSchema) {
        throw new Error("declared context schema is unavailable");
      }
      const result = validateAuthoredSchema(contextSchema, request.context);
      if (result.status !== "ok") {
        throw new Error("context validation reported issues");
      }
      context = result.value;
    } catch (error) {
      if (error instanceof ClientElicitDiagnostic) {
        throw error;
      }
      throw new ClientElicitDiagnostic(
        "client_elicit_context_invalid",
        `Context validation failed for elicitation "${request.elicitId}"`,
        request.elicitId,
      );
    }
  }

  // The registry erases the authored definition at this runtime boundary;
  // the builder has already established the concrete handler input type.
  const input = {
    message: request.message,
    context,
  } as ElicitHandlerInput<unknown>;
  const metadata: ElicitHandlerMetadata = {
    id: Object.freeze({
      toolName: request.toolName,
      key: request.key,
      callId: request.callId,
      seq: request.seq,
    }),
  };
  return yield* binding.handler(input, capabilities, metadata);
}

export interface ClientDispatcherOptions<TCapabilities> {
  readonly registry: PluginRegistry<TCapabilities>;
  readonly createCapabilities: (
    request: RawClientElicit,
    binding: ClientElicitBinding<unknown, TCapabilities>,
    signal: AbortSignal,
  ) => TCapabilities;
  readonly onCompletion: (
    request: RawClientElicit,
    completion: ElicitExchangeCompletion<unknown>,
  ) => void;
  readonly onDiagnostic?: (diagnostic: ClientElicitDiagnostic) => void;
}

interface ActiveOperation {
  readonly request: RawClientElicit;
  readonly controller: AbortController;
  readonly task: Task<void>;
}

/**
 * Scoped client lifecycle. Requests remain parked locally when binding or
 * context validation fails; registry updates retry them. Host settlement is
 * represented separately by `settled` and never inferred from local return.
 */
export interface ClientElicitDispatcher {
  observe(request: RawClientElicit): void;
  settled(elicitId: string): void;
  cancel(elicitId: string): void;
  active(elicitId: string): boolean;
  dispose(): void;
}

export function createClientElicitDispatcher<TCapabilities>(
  options: ClientDispatcherOptions<TCapabilities>,
): ClientElicitDispatcher {
  const pending = new Map<string, RawClientElicit>();
  const active = new Map<string, ActiveOperation>();
  const completionSent = new Set<string>();
  const hostSettled = new Set<string>();
  const unsubscribe = options.registry.onUpdate(() => {
    for (const request of pending.values()) {
      tryStart(request);
    }
  });

  function report(diagnostic: ClientElicitDiagnostic): void {
    options.onDiagnostic?.(diagnostic);
  }

  function tryStart(request: RawClientElicit): void {
    pending.set(request.elicitId, request);
    if (
      hostSettled.has(request.elicitId) ||
      active.has(request.elicitId) ||
      completionSent.has(request.elicitId)
    ) {
      return;
    }
    const binding = options.registry.get(request.bindingId);
    if (!binding) {
      const sameNamed = options.registry
        .bindings()
        .some(
          (candidate) => candidate.toolName === request.toolName && candidate.key === request.key,
        );
      report(
        new ClientElicitDiagnostic(
          sameNamed ? "client_elicit_binding_mismatch" : "client_elicit_binding_missing",
          sameNamed
            ? `Installed client binding evidence does not match elicitation "${request.elicitId}"`
            : `No client binding is installed for elicitation "${request.elicitId}"`,
          request.elicitId,
        ),
      );
      return;
    }
    const controller = new AbortController();
    const capabilities = options.createCapabilities(request, binding, controller.signal);
    let finishedSynchronously = false;
    const task = run(function* (): Operation<void> {
      try {
        if (controller.signal.aborted) {
          return;
        }
        const completion = yield* executeClientElicitHandler(binding, request, capabilities);
        if (completionSent.has(request.elicitId)) {
          return;
        }
        completionSent.add(request.elicitId);
        options.onCompletion(request, completion);
      } catch (error) {
        if (error instanceof ClientElicitDiagnostic) {
          report(error);
        } else if (!controller.signal.aborted) {
          report(
            new ClientElicitDiagnostic(
              "client_elicit_handler_failed",
              `Client handler failed for elicitation "${request.elicitId}"`,
              request.elicitId,
            ),
          );
        }
      } finally {
        finishedSynchronously = true;
        active.delete(request.elicitId);
      }
    });
    // `run` may finish an opaque handler before returning a Task. Do not add a
    // stale active entry after that synchronous completion; suspended handlers
    // are registered normally and removed by their finally block.
    if (!finishedSynchronously) {
      active.set(request.elicitId, { request, controller, task });
    }
    void Promise.resolve(task).catch(() => undefined);
  }

  return {
    observe(request) {
      tryStart(request);
    },
    settled(elicitId) {
      hostSettled.add(elicitId);
      pending.delete(elicitId);
      const current = active.get(elicitId);
      if (current) {
        current.controller.abort();
        void current.task.halt().catch(() => undefined);
        active.delete(elicitId);
      }
    },
    cancel(elicitId) {
      hostSettled.add(elicitId);
      pending.delete(elicitId);
      const current = active.get(elicitId);
      if (!current) {
        return;
      }
      current.controller.abort();
      void current.task.halt().catch(() => undefined);
      active.delete(elicitId);
    },
    active(elicitId) {
      return active.has(elicitId);
    },
    dispose() {
      unsubscribe();
      for (const current of active.values()) {
        current.controller.abort();
        void current.task.halt().catch(() => undefined);
      }
      active.clear();
      pending.clear();
      completionSent.clear();
      hostSettled.clear();
    },
  };
}
