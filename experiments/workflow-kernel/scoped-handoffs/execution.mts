import type { Operation } from "effection";
import {
  assertJson,
  createCheckpointExecution,
  type CheckpointExecution,
  type ExecutionBoundary,
  type Json,
  type OperationMiddleware,
} from "@sweatpants/foundation";

export interface PendingEffects {
  readonly pending: readonly {
    readonly id: number;
    readonly task: number;
    readonly request: { readonly site: string; readonly input: Json };
    readonly intent: "run" | "cancel";
  }[];
}
export interface Settlement {
  readonly id: number;
  readonly outcome:
    | { readonly kind: "value" | "throw"; readonly value: Json }
    | { readonly kind: "cancelled" };
}
export type ScopedExecution = CheckpointExecution<PendingEffects, Settlement, Json, Json, Json>;
export type ScopedBoundary = ExecutionBoundary<PendingEffects, Json, Json>;
export type SchedulerInvoker = (command: Json) => Operation<Json>;

/** Experimental evaluator adapter. The shared foundation owns lifecycle guards. */
export function* createScopedExecution(options: {
  source: string;
  input?: Json;
  snapshot?: Json;
  invoke: SchedulerInvoker;
  middleware?: readonly OperationMiddleware<ScopedExecution>[];
}) {
  const activation = crypto.randomUUID();
  let sequence = 0;
  let snapshot: Json | undefined;

  function* turn(action: string, extra: Record<string, Json> = {}): Operation<ScopedBoundary> {
    const response = yield* options.invoke({
      source: options.source,
      action,
      // CONDITIONAL-SPREAD: the JSON command omits state on initial start.
      ...(snapshot === undefined ? {} : { state: snapshot }),
      ...extra,
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("invalid_scheduler_response");
    }
    if (typeof response.error === "string") {
      throw new Error(response.error);
    }
    const result = response.ok;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("invalid_scheduler_response");
    }
    const boundary = result.boundary;
    if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
      throw new Error("invalid_scheduler_boundary");
    }
    snapshot = assertJson(result.state);
    switch (boundary.kind) {
      case "completed":
        return { kind: "completed", value: assertJson(boundary.value) };
      case "failed":
        return { kind: "failed", error: assertJson(boundary.error) };
      case "cancelled":
        return { kind: "cancelled" };
      case "suspended": {
        const request = boundary.request;
        if (
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          !Array.isArray(request.pending)
        ) {
          throw new Error("invalid_scheduler_pending_set");
        }
        const ids = new Set<number>();
        const pending = request.pending.map((p): PendingEffects["pending"][number] => {
          if (
            !p ||
            typeof p !== "object" ||
            Array.isArray(p) ||
            typeof p.id !== "number" ||
            !Number.isSafeInteger(p.id) ||
            p.id < 0 ||
            ids.has(p.id) ||
            typeof p.task !== "number" ||
            !Number.isSafeInteger(p.task) ||
            p.task < 0 ||
            (p.intent !== "run" && p.intent !== "cancel") ||
            !p.request ||
            typeof p.request !== "object" ||
            Array.isArray(p.request) ||
            typeof p.request.site !== "string"
          ) {
            throw new Error("invalid_scheduler_pending_set");
          }
          ids.add(p.id);
          return {
            id: p.id,
            task: p.task,
            intent: p.intent,
            request: { site: p.request.site, input: assertJson(p.request.input) },
          };
        });
        return {
          kind: "suspended",
          suspensionId: `${activation}:${++sequence}`,
          request: { pending },
        };
      }
      default:
        throw new Error("invalid_scheduler_boundary");
    }
  }

  snapshot = options.snapshot;
  const initial = yield* turn(snapshot === undefined ? "start" : "restore", {
    input: options.input ?? null,
  });
  return createCheckpointExecution<PendingEffects, Settlement, Json, Json, Json>({
    initial,
    middleware: options.middleware,
    validateReply(request, reply) {
      const pending = request.pending.find((p) => p.id === reply.id);
      if (!pending) {
        throw new Error("unknown_or_consumed_effect");
      }
      if (reply.outcome.kind === "cancelled" && pending.intent !== "cancel") {
        throw new Error("unsolicited_cancellation_settlement");
      }
    },
    driver: {
      *resume(_suspensionId, reply) {
        return yield* turn("settle", { id: reply.id, outcome: reply.outcome });
      },
      *cancel() {
        return yield* turn("cancel");
      },
      *capture() {
        if (snapshot === undefined) {
          throw new Error("missing_scheduler_snapshot");
        }
        return structuredClone(snapshot);
      },
      *dispose() {
        snapshot = undefined;
      },
    },
  });
}
