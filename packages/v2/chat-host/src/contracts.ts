import type { Operation, Outcome } from "@standard-durability/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type {
  Acceptance,
  OwnedChild,
  OwnedJournal,
  Recovery,
  ResolutionGrant,
} from "@sweatpan.ts/durable";
import type { GuestWork } from "@sweatpan.ts/execution";
import type {
  ChildHostingResult,
  EffectCapabilities,
  EffectGrant,
  HostedResult,
  Hosting,
} from "@sweatpan.ts/hosting";
import type { ChatToolDefinition } from "@sweatpan.ts/providers";
import type { Stream } from "@sweatpan.ts/runtime";
import type { ToolInteraction, ToolInteractionContract } from "@sweatpan.ts/tools";

/** Explicit recovery/placement adapter. Must retain the supplied program, equality
 * and acquisition semantics; no testing package or concrete codec is selected here. */
export interface ChatRecoveryFactory<Y> {
  <R>(options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, CapabilityRequest, Y, unknown, string>;
    readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  }): Recovery<R, CapabilityRequest, Y, unknown, string, unknown>;
}

/** Typed construction recipe; captures a tool's result type before catalog erasure. */
export interface ChatToolBindingOptions<R, Y> {
  readonly definition: ChatToolDefinition;
  readonly recovery: ChatRecoveryFactory<Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  /** Install capability implementations and optional Host policies. */
  configure?(context: {
    readonly host: Hosting<R, CapabilityRequest, unknown, string, Y>;
    readonly effects: EffectCapabilities<Y>;
  }): Operation<void, Y>;
}

/** Server-only catalog binding. Use createChatToolBinding to preserve author inference.
 * The pinned program is the original tool ID; model-facing names may differ. */
export interface ChatToolBinding<Y> {
  readonly program: string;
  readonly definition: ChatToolDefinition;
  readonly contract: ToolInteractionContract;
  readonly context: StandardSchemaV1;
  /** Original declarations used for answer validation, never client metadata. */
  readonly elicits: Readonly<Record<string, EffectDefinition>>;
  /** Drive a verified child with this binding's acquisition and required middleware. */
  run(
    child: OwnedChild<unknown, CapabilityRequest, unknown, string, unknown, Y>,
  ): Operation<ChildHostingResult, Y>;
}

/** Bound root recipe. The authored Guest retains its exact exchange and result
 * protocol; construction does not invent effect IDs or change persisted replay. */
export interface ChatExecutionOptions<R, D extends Record<string, EffectDefinition>, Y> {
  readonly name: string;
  readonly program: string;
  readonly journal: OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>;
  readonly effects: D;
  readonly tools: readonly ChatToolBinding<Y>[];
  readonly recovery: ChatRecoveryFactory<Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  /** Called lazily through recovery; only domain operations may enter the Guest. */
  acquire(
    grant: EffectGrant<D, Y>,
    definitions: readonly ChatToolDefinition[],
  ): ReturnType<GuestWork<R, CapabilityRequest, Y, unknown, string>>;
  readonly batch: {
    readonly effect: string;
    /** Decode the pinned program's batch envelope. Model names resolve in tools. */
    calls(input: unknown): readonly { readonly name: string; readonly input: unknown }[];
    /** Pure parent projection, in call order. No effect execution or mutable policy. */
    outcome(values: readonly unknown[]): Outcome<unknown, string>;
  };
  /** Install sampling/progress handlers and optional root Host policy. */
  configure?(context: {
    readonly host: Hosting<R, CapabilityRequest, unknown, string, Y>;
    readonly effects: EffectCapabilities<Y>;
  }): Operation<void, Y>;
}

/** Connection-bound server assembly. No background task or implicit answer/drive coupling. */
export interface ChatExecution<R, Y> {
  readonly id: string;
  /** One independently owned run; all child work and cleanup are joined. */
  run(): Operation<HostedResult<R, CapabilityRequest>, Y>;
  /** Resolve persisted descendant ownership and validate the stored request's original
   * response contract. Does not acquire a Guest, enumerate waits or drive execution. */
  answer(
    target: { readonly execution: string; readonly grant: ResolutionGrant },
    outcome: Outcome<unknown, unknown>,
  ): Operation<Acceptance<CapabilityRequest, unknown, string>, Y>;
  /** Fresh read-only pull stream, owned by the subscribing native scope. */
  interactions(): Stream<ToolInteraction, void, Y>;
}
