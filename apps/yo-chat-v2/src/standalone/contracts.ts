import type { Outcome } from "@standard-durability/core";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import type { EffectDefinition } from "@sweatpan.ts/core";
// Application-local JSON profile and delivery policy for the standalone example.
/** JSON HTTP profile for one root tool. Domain payloads must be JSON-compatible. */
export type StandaloneView<R = unknown> = {
  readonly version: "tool-http/1";
  readonly questions: readonly QuestionRecord[];
  readonly execution: string;
  readonly program: string;
} & (
  | { readonly status: "running" }
  | {
      readonly status: "waiting";
      readonly question: {
        readonly effect: string;
        readonly input: unknown;
        readonly grant: ResolutionGrant;
      };
    }
  | { readonly status: "completed"; readonly value: R }
  | { readonly status: "cancelled"; readonly reason: string }
);

export interface StandaloneAnswer {
  readonly grant: ResolutionGrant;
  readonly outcome: Outcome<unknown, unknown>;
}

/** Adapter context is structural and works directly with Start's server handlers. */
export interface StandaloneHttpContext {
  readonly request: Request;
  readonly params: { readonly execution: string };
}

/** Detached question history for a direct tool. Sequence is stable across acceptance.
 * Only declared elicits are included; capability inputs are not published here. */
export type QuestionRecord = {
  readonly sequence: number;
  readonly effect: string;
  readonly input: unknown;
} & (
  | { readonly state: "answered"; readonly outcome: Outcome<unknown, unknown> }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "waiting" }
  | { readonly state: "blocked" }
  | { readonly state: "cancelled" }
);

export interface StandaloneClientOptions {
  readonly endpoint: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Selected at connect, so constructing a client is safe during SSR. */
  readonly storage?: () => Pick<Storage, "getItem" | "setItem">;
  readonly storageKey?: string;
}
export interface StandaloneSnapshot<R> {
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly execution?: string;
  readonly pending: boolean;
  readonly view?: StandaloneView<R>;
  readonly error?: string;
}
export type StandaloneInteraction<E> =
  E extends EffectDefinition<infer C, unknown, unknown, infer A, unknown>
    ? { readonly input: C; respond(value: A): Promise<void> }
    : never;
