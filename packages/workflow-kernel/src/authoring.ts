import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type { KernelIdentity, WorkflowKernel } from "./index.ts";

/** The owner of a format validates the payload. No shared instruction set is implied. */
export interface WorkflowImplementation {
  readonly format: string;
  readonly payload: Json;
}

/** Build output; types are phantom information, not executable schemas. */
export interface CompiledWorkflow<Input = unknown, Output = unknown> {
  readonly kind: "compiled-workflow";
  readonly entry: string;
  readonly implementation: WorkflowImplementation;
  readonly source: string;
  readonly sourceLanguage: string;
  readonly debug: {
    readonly sites: Readonly<Record<string, unknown>>;
    readonly locations: Readonly<Record<string, unknown>>;
  };
  readonly types?: { input: Input; output: Output };
}

export interface WorkflowSource {
  readonly id?: string;
  readonly language: string;
  readonly text: string;
}

/** Public names are resolved by the host, never by authored registration code. */
export type WorkflowBinding =
  | {
      readonly kind: "compiled";
      readonly name: string;
      readonly definition: CompiledWorkflow;
      /** Explicit portable arguments preceding the caller's arguments (e.g. SDK context). */
      readonly prefixArguments: readonly Json[];
    }
  | {
      readonly kind: "host";
      readonly name: string;
      readonly version: string;
    };

/** Pure linking; admission/authorization and runtime schemas remain host responsibilities. */
export interface WorkflowLinker {
  readonly definitionFormat: string;
  readonly programFormat: string;
  link(input: {
    readonly caller: WorkflowSource;
    readonly bindings: readonly WorkflowBinding[];
  }): WorkflowImplementation;
}

/** Acquires compute only. Artifact loading and journal recovery are separate seams. */
export interface WorkflowRuntime {
  readonly kernelIdentity: KernelIdentity;
  readonly createKernel: () => Operation<WorkflowKernel>;
}

/** Language-owned admission diagnostics; empty string means validation succeeded. */
export interface WorkflowSourceValidator {
  readonly language: string;
  validate(source: WorkflowSource): Operation<string>;
}

/** Pure supported-source compilation. Export names map to portable definitions. */
export interface WorkflowCompiler {
  readonly sourceLanguage: string;
  readonly definitionFormat: string;
  compile(source: WorkflowSource): Readonly<Record<string, CompiledWorkflow>>;
}
