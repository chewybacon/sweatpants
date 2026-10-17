import type { Operation } from "effection";

/** Portable build output. Input/output types do not add executable validators. */
export interface CompiledWorkflow<Input, Output> {
  readonly kind: "compiled-workflow";
  readonly entry: string;
  readonly scheme: string;
  readonly source: string;
  readonly debug: {
    readonly sites: Record<string, unknown>;
    readonly locations: Record<string, unknown>;
  };
  readonly types?: { input: Input; output: Output };
}

/** Build marker: the compiler replaces this call with portable data. */
export function defineCompiledWorkflow<Context, Input, Output>(
  _generator: (ctx: Context, input: Input) => Operation<Output>,
): CompiledWorkflow<Input, Output> {
  throw new Error("Compile this module with the workflow build plugin before importing it");
}
