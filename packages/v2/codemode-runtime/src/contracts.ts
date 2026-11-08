import type { Operation } from "@standard-durability/core";

/** Authored text; neither an immutable program reference nor an execution grant. */
export interface CodeSource {
  readonly language: string;
  readonly text: string;
}

/** One-based source coordinates, only supplied when the adapter can map them accurately. */
export interface SourceLocation {
  readonly line: number;
  readonly column?: number;
}

/** Author-visible rejection or warning; infrastructure failures remain thrown errors. */
export interface CodeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly location?: SourceLocation;
}

/** Validity applies only to the named checks, never to permission or future execution. */
export interface CodeValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly CodeDiagnostic[];
  readonly checked: readonly string[];
}

/** Validation does not execute authored code, dispatch effects, or retain a live Guest. */
export interface CodeValidator<Y> {
  /** Validate this source. Loader, transport and evaluator infrastructure failures throw. */
  validate(source: CodeSource): Operation<CodeValidation, Y>;
}
