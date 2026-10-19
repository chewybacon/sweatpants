import type { Operation } from "effection";

import type { CompiledWorkflow } from "../../../packages/workflow-kernel/src/index.ts";

/** Build marker: the compiler replaces this call with portable data. */
export function defineCompiledWorkflow<Context, Input, Output>(
  _generator: (ctx: Context, input: Input) => Operation<Output>,
): CompiledWorkflow<Input, Output> {
  throw new Error("Compile this module with the workflow build plugin before importing it");
}
