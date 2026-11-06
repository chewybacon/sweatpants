import type { CheckpointAdapter, PreparedProgram, ScopeBoundary } from "@sweatpan.ts/execution";

/** Trusted loader protocol for the Scheme Execution evaluator, not Playground.
 * Each load returns a fresh machine. The loader owns wire codecs, fuel, runtime
 * verification and truthful logical-scope metadata at every effect boundary. */
export type SchemeBoundary =
  | {
      readonly kind: "effect";
      readonly site: string;
      readonly value: unknown;
      readonly scope: ScopeBoundary;
    }
  | { readonly kind: "returned" | "thrown"; readonly value: unknown }
  | { readonly kind: "cancelled" };
export interface SchemeMachine {
  start(source: string, input: unknown): SchemeBoundary;
  resume(value: unknown): SchemeBoundary;
  reject(error: unknown): SchemeBoundary;
  cancel(): SchemeBoundary;
  capture(): string;
  restore(source: string, state: string): SchemeBoundary;
  /** Dispose physically without executing authored cleanup. */
  close(): void;
}
export interface SchemeEvaluator<R, Q, Y> extends PreparedProgram<R, Q, Y> {
  readonly checkpoints: CheckpointAdapter<R, Q, Y, unknown, unknown, unknown>;
}

export interface SchemeEvaluatorOptions<R, Q> {
  readonly source: string;
  readonly input: unknown;
  /** Pin evaluator artifact + wire/scope adapter semantics, not a display name. */
  readonly identity: string;
  readonly loadMachine: () => Promise<SchemeMachine>;
  readonly decodeRequest: (boundary: Extract<SchemeBoundary, { kind: "effect" }>) => Q;
  readonly decodeResult: (value: unknown) => R;
}
