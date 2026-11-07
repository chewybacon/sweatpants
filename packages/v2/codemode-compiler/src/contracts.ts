import type { Operation } from "@standard-durability/core";
import type { SourceLocation, CodeSource } from "@sweatpan.ts/codemode-runtime";

/** Authored location of a compiler-admitted exchange, not a runtime grant. */
export interface WorkflowEffectSite {
  readonly key: string;
  readonly effect: string;
  readonly source: SourceLocation & { readonly id: string };
}

/**
 * Portable compiler boundary. The bounded Scheme S-expression dialect is the IR,
 * not an encoding of a ScriptC AST. This first profile has one input parameter,
 * domain Outcome replies, and kernel failure/cleanup semantics.
 * Frontends verify typed lowering; targets call verifyWorkflowModule on serialized
 * input. Structural verification neither validates schemas nor grants authority.
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

/** One compiled module exposed to an authored caller. Required effects are described
 * by module.effects; this request installs no handlers and confers no host authority.
 * The first supported assembly links one exported entry; unsupported names/languages
 * must reject. Neither arbitrary module graphs nor child execution are implied.
 */
export interface WorkflowLinkRequest {
  readonly module: WorkflowModule;
  readonly caller: CodeSource;
  readonly name: string;
  /** Host-selected evaluator identity, part of retained program compatibility. */
  readonly identity: string;
}

/** Data needed to select the matching kernel. Program identity
 * must bind source, evaluator and effect/source mapping. Effects describe
 * required imports, not grants. Artifact resolution/verification remains host-owned.
 */
export interface LinkedWorkflow {
  readonly language: string;
  readonly source: string;
  readonly program: string;
  readonly identity: string;
  readonly name: string;
  readonly entry: string;
  readonly effects: WorkflowModule["effects"];
}

/** Pure target-specific linking. Creates no Guest, journal, handler or runtime scope.
 * Implementations validate their caller profile and reject unsupported module forms.
 * A common interface does not promise identical source-language coverage.
 */
export interface WorkflowLinker<Artifact extends LinkedWorkflow = LinkedWorkflow> {
  readonly language: string;
  link(request: WorkflowLinkRequest): Artifact;
}
