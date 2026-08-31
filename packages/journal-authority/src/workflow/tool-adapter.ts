import type { Operation } from "effection";
import {
  type DurableProgramContext,
  type DurableProgramManifest,
  type DurableTool,
  type RecordAttemptContext,
} from "@sweatpants/durable-execution";
import type { EffectDefinition } from "@sweatpants/durable-effects";
import type { Json } from "@sweatpants/foundation";
import { emit, pullOperation, installedEffect, record, type Workflow } from "./runtime.ts";

/**
 * Executes a pinned DurableTool program on the workflow runtime.
 *
 * Tool authoring via `createPinnedDurableProgram` is the stable authoring
 * surface; this adapter is its permanent bridge onto workflow boundaries.
 * Interactions use only `pull`; effect, record, and emission remain distinct
 * durable mechanisms.
 */
export function durableToolWorkflow<I extends Json, O extends Json>(
  tool: Pick<DurableTool<I, O>, "program"> & { readonly manifest?: DurableProgramManifest<I, O> },
  input: I,
): () => Workflow<Json> {
  const context: DurableProgramContext = {
    effect: function* (
      definition: EffectDefinition<Json, Json, never>,
      input: Json,
      resolver?: { audience: string; route?: string },
    ): Operation<Json> {
      const outcome = (yield* installedEffect({
        name: definition.name,
        version: definition.version,
        input,
        resolver: resolver ?? { audience: "program-execution" },
      })) as Json;
      return outcome;
    } as unknown as DurableProgramContext["effect"],
    *record<T extends Json>(
      options: Parameters<typeof record>[0],
      operation: (attempt: RecordAttemptContext) => Operation<T>,
    ): Operation<T> {
      return yield* record(options, operation);
    },
    *emit(eventType: string, payload: Json): Operation<void> {
      yield* emit(eventType, payload);
    },
    /**
     * Single generic parked-pull boundary (REQ-009): every interaction kind
     * lowers here; per-kind sugars are thin wrappers, never new members.
     */
    *pull(descriptor: Json): Operation<Json> {
      return (yield* pullOperation(descriptor)) as Json;
    },
  };

  return () => tool.program(input, context) as unknown as Workflow<Json>;
}
