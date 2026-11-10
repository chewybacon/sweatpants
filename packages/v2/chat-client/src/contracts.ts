import type { Operation, Outcome } from "@standard-durability/core";
import type { Stream } from "@sweatpan.ts/runtime";

/** Application-defined response frames and cursors; this is not a persistent event log. */
export interface ResponseSubscriptions<Cursor, Frame, Close, Y> {
  /** Acquire in the reader scope. Cursor/source validation belongs to the installed driver. */
  subscribe(cursor: Cursor): Stream<Frame, Close, Y>;
}
/** One concrete elicitation's normalized context and authored answer. */
export interface ElicitationHandler<C, O, E, Y> {
  /** UI/automatic handling in the client scope. Transport validation and reply caching stay outside. */
  handle(context: C): Operation<Outcome<O, E>, Y>;
}

/** One application declaration associates a kind with its context and answer.
 * Distributive unions preserve that association when a catalog contains many kinds. */
export interface QuestionContract {
  readonly kind: string;
  readonly context: unknown;
  readonly response: unknown;
}
/** Display context discriminated by question kind, without answer authority. */
export type QuestionContext<Q extends QuestionContract> = Q extends QuestionContract
  ? { readonly kind: Q["kind"]; readonly context: Q["context"] }
  : never;
/** Historical question state. Narrow kind and state to obtain its exact response.
 * Answered requires a response; pending/cancelled cannot claim one. */
export type QuestionHistory<Q extends QuestionContract> = Q extends QuestionContract
  ? {
      readonly type: "question";
      readonly id: string;
      readonly kind: Q["kind"];
      readonly question: Q["context"];
    } & (
      | { readonly state: "answered"; readonly response: Q["response"] }
      | { readonly state: "pending" | "cancelled"; readonly response?: never }
    )
  : never;
/** Typed submission value. Target is application-owned routing/authority data;
 * the server must check it against the stored question and validate the value. */
export type QuestionAnswer<Q extends QuestionContract, Target> = Q extends QuestionContract
  ? { readonly kind: Q["kind"]; readonly target: Target; readonly value: Q["response"] }
  : never;

/** Portable presentation model. Order is causal placement among siblings,
 * never a wall clock or a global ordering of concurrent execution updates. */
export type ConversationPart<Q extends QuestionContract, Result = string> =
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | {
      readonly type: "message";
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly parts: readonly ConversationPart<Q, Result>[];
    }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly callId: string;
      readonly name: string;
      readonly state: "pending" | "running" | "completed" | "cancelled";
      readonly output?: Result;
      readonly parts: readonly ConversationPart<Q, Result>[];
    }
  | QuestionHistory<Q>;

type Placed<P> = P extends unknown
  ? Omit<P, "parts"> & { readonly parentId: string | null; readonly order: number }
  : never;
/** Flat placement record; application payload correlation survives materialization. */
export type ConversationNode<Q extends QuestionContract, Result = string> = Placed<
  ConversationPart<Q, Result>
>;

/** A snapshot of observation state, independent of execution status inside V.
 * The wrapper is frozen; the transport supplies readonly application view data. */
export interface ChatViewSnapshot<V> {
  readonly view: V | undefined;
  readonly status: "idle" | "loading" | "ready" | "error" | "closed";
  readonly error: unknown;
}
/** External-store subscription boundary shared by frontend bindings. */
export interface ChatViewSource<V> {
  /** Stable reference until the next published observation-state change. */
  getSnapshot(): ChatViewSnapshot<V>;
  /** Subscribe without starting work. Listener must not throw; unsubscribe affects
   * only this observer and is safe to call more than once. */
  subscribe(listener: () => void): () => void;
}
/** Application-authorized transport. Neither method implies execution advancement. */
export interface ChatViewTransport<V, Command, Receipt> {
  /** Fetch a complete readonly public view. Projection, validation and reconnect
   * mechanics belong to this implementation; no raw journal decoding is inferred. */
  observe(): Promise<V>;
  /** Submit an application-typed command; resolve only with its server receipt.
   * A rejection may be an unconfirmed delivery, not proof of non-acceptance. */
  answer(command: Command): Promise<Receipt>;
}
/** Construction does not observe or create background work. */
export interface ChatClientOptions<V, Command, Receipt> {
  readonly transport: ChatViewTransport<V, Command, Receipt>;
}
/** Caller-owned observable client. Bindings subscribe without acquiring ownership. */
export interface ChatClient<V, Command, Receipt> extends ChatViewSource<V> {
  /** Replace the view from a finite observation. Latest-started refresh wins;
   * obsolete success/failure returns the current view. Current failure retains
   * the old view, publishes error state and rejects. Close discards late results. */
  refresh(): Promise<V | undefined>;
  /** Forward without optimistic history mutation or automatic refresh/retry. */
  answer(command: Command): Promise<Receipt>;
  /** Idempotently publish closed state and release subscribers. Does not close the
   * transport, cancel submitted commands, or stop independently owned server work.
   * Further refresh/answer/subscribe calls fail. */
  close(): void;
}

/** Transport-independent, schema-decoded presentation of one tool question.
 * Answer callbacks belong to the producing session, never to a React mount.
 * Sources must maintain these relationships:
 * - outcome is present exactly when state is answered (including domain declines).
 * - submitted is present exactly when delivery is not idle, in original input form.
 * - canRespond implies pending state and idle delivery; the converse is not required.
 * Terminal observation can coexist with in-flight or unconfirmed delivery.
 * A domain decline is an answered error Outcome; failed denotes delivery failure. */
export interface ToolPresentationQuestion {
  readonly id: string;
  readonly execution: string;
  readonly program: string;
  readonly effect: string;
  readonly input: unknown;
  /** Last observed durable question state; pending includes blocked work and does not imply locally answerable. */
  readonly state: "pending" | "answered" | "cancelled" | "failed";
  /** Local answer delivery only. Idle makes no claim about acceptance. */
  readonly delivery: "idle" | "sending" | "unconfirmed";
  /** Current source policy permits a response. Advisory; the command still validates authority. */
  readonly canRespond: boolean;
  /** Original handler input while delivery is uncertain. */
  readonly submitted?: Outcome<unknown, unknown>;
  /** Accepted, schema-transformed domain result. Not the original submitted value. */
  readonly outcome?: Outcome<unknown, unknown>;
  readonly error?: string;
  /** Revalidate the owning session at call time; stale/disallowed calls are inert.
   * Resolution means the local attempt settled, not acceptance. Observe outcome for
   * acceptance and delivery/error for uncertainty; rejection alone proves no rollback. */
  respond(value: unknown): Promise<void>;
  /** Absent when this source does not support domain declines. Same call rules as respond. */
  decline?(error: unknown): Promise<void>;
}
/** getSnapshot returns the same immutable snapshot until it changes. Publish the new
 * snapshot before notifying subscribers; unsubscribe stops future notifications.
 * An immutable source may have a no-op subscription if its owner replaces the source
 * object when data changes (and propagates that replacement to consumers). */
export interface ToolPresentationSource {
  getSnapshot(): readonly ToolPresentationQuestion[];
  subscribe(notify: () => void): () => void;
}
