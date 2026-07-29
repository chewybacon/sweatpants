/**
 * Authoring surface declarations.
 *
 * What an author touches when writing a durable program or an effect handler.
 * Depends only on the contract layer, so authored code never sees authority or
 * driver protocol vocabulary.
 */

import type { Operation } from "effection";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema-descriptor";
import type {
  DurableEffectAuthorization as CanonicalDurableEffectAuthorization,
  DurableEffectContext as CanonicalDurableEffectContext,
  DurableEffectHandler as CanonicalDurableEffectHandler,
  DurableEffectRegistration as CanonicalDurableEffectRegistration,
} from "@sweatpants/durable-effects";
import type { Json } from "./types.ts";
import type {
  DurableChildDescriptor,
  DurableOperationDescriptor,
  DurableProgramManifest,
  DurableTaskHandle,
  EffectDefinition,
  EmissionDescriptor,
  ForeignToolRequest,
  GeneratedProgramArtifactIdentityV1,
  OperationOutcome,
  ProgramIdentityProvenanceV1,
  RetrySafety,
  WireElicitResultJson,
} from "./durable-contract-types.ts";

/** Resume value injected into a suspended durable program boundary. */
export type ProgramResume = OperationOutcome | undefined;

/** Closed set of proposals an authored durable program task may publish. */
export type ProgramStepProposal =
  | { type: "operation"; descriptor: DurableOperationDescriptor; execute?: RecordedOperation }
  | { type: "emission"; descriptor: EmissionDescriptor };

export interface RecordAttemptContext {
  readonly pullId: string;
  readonly attemptId: string;
  readonly cancellation: AbortSignal;
}

export type RecordedOperation = (context: RecordAttemptContext) => Operation<Json>;

export interface RecordOptions {
  readonly label?: string;
  readonly retrySafety?: RetrySafety;
}

/** Authoring API that constructs only declared, serializable durable proposals. */
export interface DurableProgramContext {
  /** Proposes a declared host effect and returns its schema-parsed recorded result. */
  effect<I extends Json, O extends Json, P extends Json = never>(
    definition: EffectDefinition<I, O, P>,
    input: I,
    resolver: { audience: string; route?: string },
  ): Operation<O>;
  effect<T extends Json = Json>(
    name: string,
    version: string,
    input: Json,
    resolver: { audience: string; route?: string },
  ): Operation<T>;
  /** Records one execution-owned Effection operation; replay returns the accepted outcome. */
  record<T extends Json>(operation: () => Operation<T>): Operation<T>;
  record<T extends Json>(label: string, operation: () => Operation<T>): Operation<T>;
  record<T extends Json>(
    options: RecordOptions,
    operation: (context: RecordAttemptContext) => Operation<T>,
  ): Operation<T>;
  /** Proposes user input; accepted content must satisfy the descriptor's registered validator. */
  elicit<T extends Json = Json>(
    key: string,
    message: string,
    response: PortableSchemaDescriptor,
    context?: Json,
  ): Operation<WireElicitResultJson<T>>;
  /** Proposes an ordered, durable public emission. */
  emit(eventType: string, payload: Json): Operation<void>;
  /** Deterministic scheduler operations; relative sleeps become persisted absolute deadlines. */
  clock: {
    /** Waits until a valid absolute instant. */
    waitUntil(instant: string, key?: string): Operation<void>;
    /** Sleeps for a nonnegative duration recorded once by the authority. */
    sleep(durationMs: number, key?: string): Operation<void>;
  };
  /** Invokes and joins one deterministic child task. */
  invoke<T extends Json = Json>(child: DurableChildDescriptor): Operation<T>;
  /** Invokes children and returns their ordered results after all close. */
  all<T extends readonly Json[] = readonly Json[]>(
    children: DurableChildDescriptor[],
  ): Operation<T>;
  /** Invokes children and returns the authority-recorded winner. */
  race<T extends Json = Json>(children: DurableChildDescriptor[]): Operation<T>;
  /** Spawns an owned child and returns an owner-bound handle. */
  spawn(child: DurableChildDescriptor): Operation<DurableTaskHandle>;
  /** Joins a child handle owned by this program. */
  join<T extends Json = Json>(handle: DurableTaskHandle): Operation<T>;
  /** Invokes a classified foreign driver without upgrading its declared durability. */
  foreignTool<T extends Json = Json>(request: ForeignToolRequest): Operation<T>;
}

/** Effection-native factory for one durable program operation. */
export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => Operation<O>;

/** Crank-native program pairing a pinned manifest with its Effection implementation. */
export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableProgramFactory<I, O>;
  /** Explicit evidence describing whether the digest was generated or manually asserted. */
  readonly identityProvenance: ProgramIdentityProvenanceV1;
  /** Local verification evidence retained only for generated bindings. */
  readonly identityArtifact?: GeneratedProgramArtifactIdentityV1;
}

/** Canonical durable-effects dispatch authorization. */
export type DurableEffectAuthorization = CanonicalDurableEffectAuthorization;

/** Canonical durable-effects handler context. */
export type DurableEffectContext = CanonicalDurableEffectContext;

/** Canonical durable-effects handler identity. */
export type DurableEffectHandler<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> = CanonicalDurableEffectHandler<I, O, P>;

/** Canonical durable-effects registration identity. */
export type DurableEffectRegistration = CanonicalDurableEffectRegistration;

/** Immutable symbolic effect registry installed at composition. */
export type DurableEffectRegistry = ReadonlyMap<string, DurableEffectRegistration>;
