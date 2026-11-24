import type { Operation, Outcome } from "@standard-durability/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { Acceptance, OwnedChild, OwnedJournal, ResolutionGrant } from "@sweatpan.ts/durable";
import type { GuestWork } from "@sweatpan.ts/execution";
import type {
  ChildHostingResult,
  EffectCapabilities,
  EffectGrant,
  HostedResult,
  Hosting,
} from "@sweatpan.ts/hosting";
import type { ChatToolCall, ChatToolDefinition } from "@sweatpan.ts/providers";
import type { Stream } from "@sweatpan.ts/runtime";
import type {
  ToolInteraction,
  ToolInteractionContract,
  ToolRecoveryFactory,
  ToolSession,
} from "@sweatpan.ts/tools";
import type {
  ChatHistoryMessage,
  ChatLoopResult,
  ChatLoopSample,
  ChatSampling,
  ChatToolResult,
} from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";

/** A routing or schema error before authored tool execution. */
export type ChatToolRejection =
  | { readonly reason: "unknown-tool"; readonly name: string }
  | {
      readonly reason: "invalid-input";
      readonly name: string;
      readonly issues: readonly StandardSchemaV1.Issue[];
    };

/** Immutable application policy around the versioned recorded chat protocol.
 * All projections are synchronous, pure and replay-stable. Bump id when changing
 * their meaning, the tool catalog or other authored behavior for existing journals. */
export interface ChatProgramOptions<R> {
  readonly id: string;
  /** Validate/project already-admitted input; never read mutable client state. */
  history(admittedInput: unknown): readonly ChatHistoryMessage[];
  /** Format a terminal tool value for the model. Correlation is supplied internally. */
  toolResult(value: unknown, call: ChatToolCall): Pick<ChatToolResult, "content" | "isError">;
  /** Opt in to recording an application value for an uncallable tool. toolResult formats it. */
  rejectToolCall?(rejection: ChatToolRejection): unknown;
  /** Application result projection; use identity to retain the complete chat result. */
  result(result: ChatLoopResult): R;
}

/** Per-connection infrastructure. Sampling adapters own provider wire validation. */
export interface ChatProgramBinding<R, Y> {
  readonly journal: OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>;
  readonly tools: readonly ChatToolBinding<Y>[];
  readonly recovery: ChatRecoveryFactory<Y>;
  readonly sampling: ChatSampling<Y>;
  /** Prefix the projected history with immutable messages referenced by admission. */
  readonly historySource?: ChatHistorySource<Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  /** Optional root policy; child policy belongs to each tool binding. */
  configure?(host: Hosting<R, CapabilityRequest, unknown, string, Y>): Operation<void, Y>;
}

/** A recorded-chat journal request, decoded without exposing its stored envelope. */
export type RecordedChatRecord =
  | {
      readonly kind: "sample";
      /** Zero-based round within the execution. */
      readonly round: number;
      /** Pending has no outcome yet; denied is an accepted sampling-policy rejection. */
      readonly state: "pending" | "accepted" | "denied";
      readonly sample?: ChatLoopSample;
    }
  | {
      readonly kind: "tools";
      /** Model calls in batch order, matching the owned child links of the request. */
      readonly calls: readonly {
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }[];
    };

/** Recorded sampling and owned tool-batch protocol, shared by every binding/reopen. */
export interface ChatProgram<R> {
  /** Persist this complete ID, including the framework protocol revision, at admission. */
  readonly id: string;
  /** Decode this program's request and optional accepted outcome. Other effects return
   * undefined. Pure; trusted journal data only, and no disclosure policy is applied. */
  decode(entry: {
    readonly request: unknown;
    readonly outcome?: unknown;
  }): RecordedChatRecord | undefined;
  /** Pure connection-bound assembly. Creates no Guest or native task until run. */
  bind<Y>(runtime: Runtime<Y>, options: ChatProgramBinding<R, Y>): RecordedChatExecution<R, Y>;
}

/** Explicit recovery/placement adapter. Must retain the supplied program, equality
 * and acquisition semantics; no testing package or concrete codec is selected here. */
export type ChatRecoveryFactory<Y> = ToolRecoveryFactory<Y>;

/** Typed construction recipe; captures a tool's result type before catalog erasure. */
export interface ChatToolBindingOptions<R, Y, Input = unknown> {
  readonly definition: ChatToolDefinition;
  readonly recovery: ChatRecoveryFactory<Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  /** Install capability implementations and optional Host policies. */
  configure?(
    context: Pick<
      ToolSession<unknown, Input, R, Y>,
      "host" | "effects" | "recovery" | "acquisition"
    >,
  ): Operation<void, Y>;
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
    /** Optional pure projection for routing and validation failures at initial admission. */
    rejectToolCall?(rejection: ChatToolRejection): unknown;
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

/** Application-owned read of messages that precede an admitted conversation.
 * Runs before the first sample and history read; changed content diverges on replay. */
export interface ChatHistorySource<Y> {
  read(admittedInput: unknown): Operation<readonly ChatHistoryMessage[], Y>;
}

/** One accepted model sample in a recorded conversation. Denied samples are omitted. */
export interface RecordedChatSample {
  /** Zero-based round within this execution. */
  readonly round: number;
  /** Accepted journal position of the sample. */
  readonly sequence: number;
  readonly receipt: string;
  readonly sample: ChatLoopSample;
}

/** Reconstructs accepted messages without acquiring a Guest or advancing delivery.
 * One connection-bound cache; callers serialize history() and run(). */
export interface RecordedChatExecution<R, Y> extends ChatExecution<R, Y> {
  history(): Operation<readonly ChatHistoryMessage[], Y>;
  /** Newest accepted sample, read backward from the current accepted frontier. */
  latestSample(): Operation<RecordedChatSample | undefined, Y>;
}
