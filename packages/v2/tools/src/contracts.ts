import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api, Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { GuestWork, Guest, LogicalScope, ScopeInstruction } from "@sweatpan.ts/execution";
import type {
  Acceptance,
  JournalSnapshot,
  InteractionRegistration,
  OwnedJournal,
  Recovery,
  OwnedChild,
  ChildLink,
  Interactions,
  JournalReader,
  PendingRequest,
  ResolutionGrant,
  RootCancellation,
} from "@sweatpan.ts/durable";
import type {
  EffectCapabilities,
  EffectGrant,
  ChildHostingResult,
  HostedResult,
  Hosting,
} from "@sweatpan.ts/hosting";

/** Authored operations available inside an evaluator-owned tool body. */
export interface ToolContext<
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  Y,
> {
  /** Calls declared capabilities, returning their domain Outcomes as data.
   * Rejection does not implicitly throw; the host separately grants authority. */
  readonly capabilities: { readonly [K in keyof D]: D[K]["call"] };
  /** Logical scope owning the body's registered cleanup and critical regions. */
  readonly scope: LogicalScope;
  /** Existing journal sandwich; omitted keys use positional recording identity. */
  readonly record: ReturnType<EffectCapabilities<Y>["grant"]>["record"];
  /**
   * Execute a Promise factory through the existing recording grant. Accepted values
   * replay without executing the factory. Rejection remains a delivery error and
   * leaves the attempt unsettled. Unrecorded Promise execution is not supported.
   */
  await<T>(
    start: (signal: AbortSignal) => PromiseLike<T>,
    options: { readonly record: { readonly key?: string } },
  ): Operation<T, CapabilityRequest>;
  /** Request a declared external interaction, preserving its input and Outcome types.
   * Domain rejection is data for authored control flow, not a delivery failure. */
  elicit<K extends keyof L>(key: K, ...args: Parameters<L[K]["call"]>): ReturnType<L[K]["call"]>;
}

/**
 * An ordinary callable effect whose implementation is an evaluator-owned body.
 * Input is normalized by admission before acquisition. Result inference is not
 * runtime result validation. Declaration alone grants no invocation authority.
 */
export interface ToolDefinition<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
> extends EffectDefinition<
  StandardSchemaV1.InferOutput<S>,
  R,
  StandardSchemaV1.InferInput<S>,
  R,
  never
> {
  /** Original parameter schema, retained for admission and contract inspection. */
  readonly context: S;
  /** Capability declarations available to the body; implementations remain host-owned. */
  readonly capabilities: D;
  /** External interactions, represented by the same effect primitive. */
  readonly elicits: L;
  /** Controlled iterator body; arbitrary native runtime yields are not supported. */
  readonly body: <Y>(
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<D, L, Y>,
  ) => Operation<R, CapabilityRequest | ScopeInstruction>;
}

/**
 * Typed local view of an authored tool without its body or default implementations.
 * Schemas and domain call builders are retained by reference, not serialized or
 * deep-frozen. This is neither a browser import boundary nor an authority grant.
 * Inferred results are compile-time information, not a runtime result validator.
 */
export interface ToolContract<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
> extends EffectDefinition<
  StandardSchemaV1.InferOutput<S>,
  R,
  StandardSchemaV1.InferInput<S>,
  R,
  never
> {
  readonly context: S;
  /** Public effect surfaces; aliases and exact call/schema types are preserved. */
  readonly capabilities: { readonly [K in keyof D]: Pick<D[K], keyof EffectDefinition> };
  /** Declared interactions; no default handler or tool body is exposed. */
  readonly elicits: { readonly [K in keyof L]: Pick<L[K], keyof EffectDefinition> };
}

/** Immutable builder retaining schema, capability and elicitation inference. */
export interface ToolBuilder<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition> = {},
  L extends Record<string, EffectDefinition> = {},
> {
  /** Replace the declared capabilities without granting execution authority. */
  capabilities<const Next extends Record<string, EffectDefinition>>(
    definitions: Next,
  ): ToolBuilder<S, Next, L>;
  /** Replace the declared external interactions. */
  elicits<const Next extends Record<string, EffectDefinition>>(
    definitions: Next,
  ): ToolBuilder<S, D, Next>;
  /** Finish the declaration, inferring the terminal result from the body. */
  execute<R>(body: ToolDefinition<S, D, L, R>["body"]): ToolDefinition<S, D, L, R>;
}

/** Optional automatic handlers keyed by a tool's declared elicits. Omitted keys park for a participant. */
export type ElicitHandlers<L extends Record<string, EffectDefinition>, Y> = {
  readonly [K in keyof L]?: L[K] extends EffectDefinition<
    infer C,
    infer _R,
    infer _I,
    infer O,
    infer E
  >
    ? (context: C) => Operation<Outcome<O, E>, Y>
    : never;
};

/** Scoped native acquisition and its host-facing delivery facade. */
export interface ToolAcquisition<I, R, Y> extends Api<
  {
    /**
     * Acquire one Guest in its owning scope from already-admitted input. No schema
     * parsing or journal writes occur. Default acquisition grants declared effects
     * and local recording; scope exit releases recording bindings. Acquire once per
     * incarnation in a separate owning scope. Native recording requires retention.
     */
    acquire(input: I): Operation<Guest<R, CapabilityRequest, Y>, Y>;
  },
  Y
> {
  /** Admit through the current incarnation's grant, before owned-child routing. */
  readonly admission: EffectGrant<Record<string, EffectDefinition>, Y>["admission"];
  /** Deliver through the current incarnation; handlers are installed separately. */
  handle(request: CapabilityRequest): Operation<Outcome<unknown, string>, Y>;
}

/** Submission policy for one bound tool and journal. Recovery never calls this API. */
export interface ToolAdmission<I, O, Y> {
  /** Each submission may run policy/validation, including duplicates. No exactly-once quota promise. */
  admit(input: I): Operation<O, Y>;
}

/** One named-tool route installed on the existing Hosting.child operation. */
export interface ToolRoute<S extends StandardSchemaV1, R, Y, ParentError = string> {
  readonly tool: { readonly id: string; readonly context: S };
  /** Drive this child and return childHostingResult(result), preserving yields and blocking reasons. */
  run(
    child: OwnedChild<R, CapabilityRequest, unknown, string, unknown, Y>,
  ): Operation<ChildHostingResult, Y>;
  /** Pure synchronous parent projection; default wraps the child's result as authored success. */
  readonly outcome?: (value: R) => Outcome<unknown, ParentError>;
}

/** Connection-bound ingress for one persisted tool execution, independent of a live Guest. */
export interface ToolExecution<Tool, E, Y> {
  readonly execution: string;
  /** Original server definition selected by persisted program identity, not client input. */
  readonly tool: Tool;
  readonly interactions: Pick<Interactions<CapabilityRequest, unknown, E, Y>, "request" | "answer">;
}

/** Trusted application wiring for resolving an existing direct tool child. */
export interface ToolExecutionResolution<Tool extends { readonly id: string }, E, Y> {
  /** Already-authorized parent; only its persisted direct children are reachable. */
  readonly owner: Pick<
    JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
    "id" | "openChild"
  >;
  /** Original compatible definitions. Matching IDs cannot prove code/version compatibility. */
  readonly programs: ReadonlyMap<string, Tool>;
  /**
   * Open the existing child's ingress on this same owner's connection, using the
   * verified program's response contract. Called only after ownership/catalog checks.
   * OwnedJournal.openChildInteractions supplies this without result projections.
   * Must not acquire a Guest, deliver effects or create a replacement execution.
   * Rebuild after connection close.
   */
  bind(
    execution: string,
    program: string,
  ): Operation<
    {
      readonly link: ChildLink;
      readonly journal: {
        readonly id: string;
        readonly interactions: ToolExecution<Tool, E, Y>["interactions"];
      };
    },
    Y
  >;
}

/** Authored-tool discovery metadata; original or projected declarations are accepted.
 * Schemas remain trusted local objects. No executable body or response handler is needed.
 */
export interface ToolInteractionContract {
  readonly id: string;
  readonly elicits: Readonly<Record<string, Pick<EffectDefinition, "id" | "context" | "response">>>;
}

/** One observed, registered question. Not a lease, wire envelope or whole-tree status. */
export interface ToolInteraction {
  readonly execution: string;
  readonly program: string;
  readonly parent: { readonly execution: string; readonly requestId: string } | undefined;
  readonly revision: number;
  readonly grant: ResolutionGrant;
  /** Matching declaration retained by reference; use original definitions for answer grants. */
  readonly declaration: ToolInteractionContract["elicits"][string];
  /** Unparsed request input. Program lookup does not establish a static payload type. */
  readonly input: unknown;
  readonly scope: PendingRequest<unknown>["scope"];
  /** Local journal control facts; does not aggregate ancestor cancellation. */
  readonly cancellation: RootCancellation<unknown> | undefined;
  readonly cancellationRequested: RootCancellation<unknown> | undefined;
}

/** Declared handler coverage for a tool; not a compatibility proof or permission grant. */
export interface ElicitSupport {
  readonly tool: string;
  readonly elicits: readonly string[];
}

/** Retain with admitted work; reconnect advertisements must not rewrite this policy. */
export interface ElicitSelection {
  readonly tool: string;
  readonly routes: Readonly<Record<string, "client" | "server">>;
}

/** Already-authorized inventory; server handlers take precedence over client support. */
export interface ToolSupportCandidate {
  readonly tool: Pick<ToolInteractionContract, "id" | "elicits">;
  readonly server: readonly string[];
}
export interface ToolSupportSelection {
  readonly available: readonly ElicitSelection[];
  readonly unavailable: readonly { readonly tool: string; readonly missing: readonly string[] }[];
}

/** Local dispatch input. Transport decoding and answer authority belong to the caller. */
export type ElicitRequest = Pick<
  ToolInteraction,
  "execution" | "program" | "grant" | "declaration" | "input"
>;
export interface ElicitMetadata<Key extends PropertyKey = string> {
  readonly execution: string;
  readonly program: string;
  readonly key: Key;
  readonly requestId: string;
  readonly resolutionId: string;
}
export interface ElicitHandlerInput<Input> {
  readonly context: Input;
}
export type ElicitHandlerContext<Capabilities, Key extends PropertyKey = string> = Capabilities & {
  readonly interaction: ElicitMetadata<Key>;
};

/** Partial frontend handlers; context is schema output, successful reply is schema input. */
export type ClientElicitHandlers<L extends Record<string, EffectDefinition>, C, Y> = {
  readonly [K in keyof L]?: L[K] extends EffectDefinition<
    infer Input,
    infer _R,
    infer _I,
    infer Reply,
    infer Failure
  >
    ? (
        args: ElicitHandlerInput<Input>,
        ctx: ElicitHandlerContext<C, K>,
      ) => Operation<Outcome<Reply, Failure>, Y>
    : never;
};

/** Immutable declaration with no runtime, capability instances or task ownership. */
export interface ElicitPlugin<L extends Record<string, EffectDefinition>, C, Y> {
  readonly contract: ToolInteractionContract;
  readonly support: ElicitSupport;
  readonly handlers: ClientElicitHandlers<L, C, Y>;
}
export interface ElicitPluginBuilder<L extends Record<string, EffectDefinition>, C> {
  onElicit<Y = never>(handlers: ClientElicitHandlers<L, C, Y>): ElicitPlugin<L, C, Y>;
}

/** Frontend invocation only; returning an Outcome is not durable answer acceptance. */
export interface ElicitResponder<Y> {
  respond(
    selection: ElicitSelection,
    question: ElicitRequest,
  ): Operation<Outcome<unknown, unknown>, Y>;
}

/** Placement/recovery policy. Preserve the supplied program, admitted acquisition
 * and request equality; own every acquired Guest in the invoking scope. */
export interface ToolRecoveryFactory<Y> {
  <R>(options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, CapabilityRequest, Y, unknown, string>;
    readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  }): Recovery<R, CapabilityRequest, Y, unknown, string, unknown>;
}

/** Exact capability instances used by a bound tool. Installation is scoped, not
 * serialized to a worker. Recovery/placement must establish remote bindings explicitly. */
export interface ToolSession<I, O, R, Y> {
  readonly journal: OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>;
  readonly admission: Api<ToolAdmission<I, O, Y>, Y>;
  readonly effects: EffectCapabilities<Y>;
  readonly acquisition: ToolAcquisition<O, R, Y>;
  readonly recovery: Recovery<R, CapabilityRequest, Y, unknown, string, unknown>;
  readonly host: Hosting<R, CapabilityRequest, unknown, string, Y>;
  /** Validate/pin input, then run. Identical normalized admission is idempotent. */
  start(input: I): Operation<HostedResult<R, CapabilityRequest>, Y>;
  read(): ReturnType<OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>["read"]>;
  /** Recover using persisted normalized input. Owns a fresh child scope per run. */
  run(): Operation<HostedResult<R, CapabilityRequest>, Y>;
  /** Validate and accept only; advancing after acceptance is an explicit caller choice. */
  answer(
    grant: ResolutionGrant,
    outcome: Outcome<unknown, unknown>,
  ): Operation<Acceptance<CapabilityRequest, unknown, string>, Y>;
}

export interface ToolSessionOptions<I, O, R, Y> {
  /** Verified parent-owned link supplies normalized child input. Root start is unavailable. */
  readonly child?: ChildLink;
  /** Installed after required wiring, once per command in its owned scope. */
  configure?(session: ToolSession<I, O, R, Y>): Operation<void, Y>;
  readonly journal: OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
  /** Defaults to local replay. May select compatible placement and checkpoints. */
  readonly recovery?: ToolRecoveryFactory<Y>;
}

/** Detached observation: no connection-bound history readers escape a command. */
export type ToolApplicationSnapshot<R> = JournalSnapshot<R, CapabilityRequest, unknown> & {
  readonly interaction?: InteractionRegistration;
};

export interface ToolApplicationMethods<I, R, Y> {
  start(execution: string, input: I): Operation<HostedResult<R, CapabilityRequest>, Y>;
  run(execution: string): Operation<HostedResult<R, CapabilityRequest>, Y>;
  read(execution: string): Operation<ToolApplicationSnapshot<R>, Y>;
  answer(
    execution: string,
    grant: ResolutionGrant,
    outcome: Outcome<unknown, unknown>,
  ): Operation<Acceptance<CapabilityRequest, unknown, string>, Y>;
}

/** Stateless application recipe. Each command owns an inherited child scope.
 * Storage acquisition registers cleanup there. No implicit task, HTTP protocol,
 * global resource owner, authentication or background advancement. */
export interface ToolApplicationOptions<I, O, R, Y> extends Omit<
  ToolSessionOptions<I, O, R, Y>,
  "journal" | "child"
> {
  readonly name: string;
  open(
    execution: string,
  ): Operation<OwnedJournal<R, CapabilityRequest, unknown, string, unknown, Y>, Y>;
  /** Runs for every command, including reads and answers. Use caller-owned contexts
   * for transient identity; persisted input, not request context, drives replay. */
  configure?(session: ToolSession<I, O, R, Y>): Operation<void, Y>;
}
