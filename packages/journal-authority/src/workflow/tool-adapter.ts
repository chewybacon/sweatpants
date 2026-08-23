import type { Operation } from "effection";
import {
  CrankError,
  type DurableChildDescriptor,
  type DurableProgramContext,
  type DurableProgramManifest,
  type DurableTool,
  type RecordAttemptContext,
} from "@sweatpants/durable-execution";
import type { EffectDefinition } from "@sweatpants/durable-effects";
import type { ProgramElicitResult } from "@sweatpants/durable-execution";
import type { Json, PortableSchemaDescriptor } from "@sweatpants/foundation";
import {
  elicit,
  emit,
  pullOperation,
  installedEffect,
  invoke,
  record,
  wait,
  type Workflow,
} from "./runtime.ts";

/**
 * Executes a pinned DurableTool program on the workflow runtime.
 *
 * Tool authoring via `createPinnedDurableProgram` is the stable authoring
 * surface; this adapter is its permanent bridge onto the workflow boundary
 * helpers. Context members map one-to-one onto workflow boundaries.
 * Parallel combinators (`all`, `race`, `spawn`, `join`) are rejected eagerly:
 * the runtime fails those kinds closed too. `foreignTool` lowers onto an
 * invoke of the host-configured foreign adapter child program; without a
 * configured factory it fails closed like legacy.
 */
export function durableToolWorkflow<I extends Json, O extends Json>(
  tool: Pick<DurableTool<I, O>, "program"> & { readonly manifest?: DurableProgramManifest<I, O> },
  input: I,
): () => Workflow<Json> {
  const unsupported = (member: string) => (): never => {
    throw new CrankError(
      "invalid_descriptor",
      `Adapter does not support the ${member} context member`,
    );
  };

  const isDefinition = (
    candidate: EffectDefinition<Json, Json, never> | string,
  ): candidate is EffectDefinition<Json, Json, never> => typeof candidate !== "string";

  const context: DurableProgramContext = {
    // The two context-effect overloads collapse onto one installed-effect boundary;
    // the payload is schema-validated by the authority against the manifest.
    effect: function* (
      definitionOrName: EffectDefinition<Json, Json, never> | string,
      versionOrInput: string | Json,
      maybeInput?: Json,
      resolver?: { audience: string; route?: string },
    ): Operation<Json> {
      const definition = isDefinition(definitionOrName) ? definitionOrName : undefined;
      const name = definition ? definition.name : (definitionOrName as string);
      // Legacy authoring allowed version-less effect proposals; resolve the
      // version from the pinned manifest exactly like the local driver did.
      const version = definition
        ? definition.version
        : ((definitionOrName === undefined ? undefined : (versionOrInput as string)) ??
          tool.manifest?.effects?.[name]?.version ??
          "");
      const outcome = (yield* installedEffect({
        name,
        version,
        input: definition ? (versionOrInput as Json) : ((maybeInput ?? undefined) as Json),
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
    *elicit<T extends Json = Json>(
      key: string,
      message: string,
      response: PortableSchemaDescriptor,
      context?: Json,
      contextContract?: PortableSchemaDescriptor,
      binding?: { readonly id: string },
    ): Operation<ProgramElicitResult<T>> {
      const settled = (yield* elicit({
        key,
        message,
        response,
        ...(context === undefined ? {} : { context }),
        ...(contextContract === undefined ? {} : { contextContract }),
        ...(binding === undefined ? {} : { binding }),
      })) as unknown as ProgramElicitResult<T>;
      return settled;
    },
    *emit(eventType: string, payload: Json): Operation<void> {
      yield* emit(eventType, payload);
    },
    clock: {
      *waitUntil(instant: string, key = "waitUntil"): Operation<void> {
        yield* wait({ key, notBefore: instant });
      },
      *sleep(durationMs: number, key = "sleep"): Operation<void> {
        yield* wait({ key, durationMs });
      },
    },
    *invoke<T extends Json = Json>(child: DurableChildDescriptor): Operation<T> {
      return (yield* invoke({ child })) as T;
    },
    all: unsupported("all"),
    race: unsupported("race"),
    spawn: unsupported("spawn"),
    join: unsupported("join"),
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
