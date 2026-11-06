import type { Operation } from "@standard-durability/core";
import type { SourceLocation } from "@sweatpan.ts/codemode-runtime";

/** Authored location of a compiler-admitted exchange, not a runtime grant. */
export interface WorkflowEffectSite {
  readonly key: string;
  readonly effect: string;
  readonly source: SourceLocation & { readonly id: string };
}

/**
 * Portable compiler boundary. The bounded Scheme S-expression dialect is the IR,
 * not an encoding of a ScriptC AST. This first profile has one input parameter,
 * direct successful replies, and kernel failure/cleanup semantics.
 * Frontends must verify their emitted forms; this type is not a security proof.
 */
export interface WorkflowModule {
  readonly format: "workflow-scheme/1";
  readonly sexpressions: string;
  readonly entry: { readonly name: string; readonly parameters: "input" };
  /** Registered effects keyed by yield-at site; schemas/handlers remain assembly-owned. */
  readonly effects: Readonly<Record<string, WorkflowEffectSite>>;
}

/** Build-time lowering owns no Guest, journal, handler or invocation authority. */
export interface WorkflowFrontend<Input, Y> {
  lower(input: Input): Operation<WorkflowModule, Y>;
}

/** Targets consume only the shared dialect and metadata, never frontend types. */
export interface WorkflowTarget<Artifact> {
  emit(module: WorkflowModule): Artifact;
}
