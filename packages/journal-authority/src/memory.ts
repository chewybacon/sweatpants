import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { DurableReference, ExecutionId } from "@sweatpants/durable-execution";
import { call, type Operation } from "effection";
import type {
  AppendReplayRequest,
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
  VersionedExecution,
} from "./store.ts";

/** In-memory persistence driver. It stores opaque records and makes no transition decisions. */
export function createMemoryExecutionStore(): ExecutionStore {
  const executions = new Map<ExecutionId, VersionedExecution>();
  const payloads = new Map<string, Json | Uint8Array>();
  const replays = new Map<string, readonly Json[]>();
  let sequence = 0;

  function reference(prefix: string, value: Json | Uint8Array): DurableReference {
    sequence += 1;
    const id = `${prefix}-${sequence}`;
    payloads.set(id, value);
    return {
      id,
      byteLength:
        value instanceof Uint8Array ? value.byteLength : canonicalSnapshot(value).canonical.length,
    };
  }

  return {
    *loadExecution(executionId): Operation<VersionedExecution | null> {
      return yield* call(() => executions.get(executionId) ?? null);
    },
    *commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult> {
      return yield* call<CommitExecutionResult>(() => {
        const current = executions.get(request.executionId) ?? null;
        const actualRevision = current?.revision ?? null;
        if (actualRevision !== request.expectedRevision)
          return { status: "conflict" as const, actualRevision };
        const revision = (actualRevision ?? -1) + 1;
        executions.set(request.executionId, { revision, record: request.next });
        return { status: "accepted" as const, revision };
      });
    },
    *putPayload(value): Operation<DurableReference> {
      return yield* call(() => reference("payload", value));
    },
    *getPayload(reference): Operation<Json | Uint8Array | null> {
      return yield* call(() => payloads.get(reference.id) ?? null);
    },
    *appendReplay(request: AppendReplayRequest): Operation<DurableReference> {
      return yield* call(() => {
        const ref = reference("replay", { entries: [...request.entries] });
        replays.set(ref.id, request.entries);
        return ref;
      });
    },
    *readReplay(head): Operation<readonly Json[]> {
      return yield* call(() => (head ? (replays.get(head.id) ?? []) : []));
    },
  };
}
