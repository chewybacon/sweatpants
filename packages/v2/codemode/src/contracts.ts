import type { Operation } from "@standard-durability/core";

/** Assembly-supplied description of an already-selected callable binding.
 * Contract text is guidance, not a schema validator, executable binding or grant. */
export interface CodeBindingDescription {
  readonly name: string;
  readonly description: string;
  readonly contract: string;
}

/** Describe only the selected catalog. Permission and elicit coverage are caller-owned. */
export interface AuthoringRequest {
  readonly bindings: readonly CodeBindingDescription[];
}

/** Language instructions for an authoring model; not executable source. */
export interface AuthoringGuide {
  readonly language: string;
  readonly instructions: string;
}

/** Language guidance selected independently from model sampling and program execution. */
export interface CodeAuthoring<Y> {
  /** Describe the supplied catalog without sampling, executing, or admitting a program. */
  describe(request: AuthoringRequest): Operation<AuthoringGuide, Y>;
}
