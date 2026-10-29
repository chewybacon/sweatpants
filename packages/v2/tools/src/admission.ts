import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "@standard-durability/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";

/**
 * Validate a new root invocation and atomically pin its normalized input.
 * Schema rejection writes nothing and acquires no Guest. Each submission validates;
 * equal normalized resubmissions return the stored value, conflicts reject.
 * Recovery reads journal admission directly without calling this function again.
 * Validation can suspend outside the transaction: concurrent submissions may both
 * validate, but the journal atomically selects one input. This is admission only;
 * it neither installs capabilities nor starts execution.
 */
export function* admitTool<S extends StandardSchemaV1, Y>(
  runtime: Pick<Runtime<Y>, "fromPromise">,
  tool: { readonly id: string; readonly context: S },
  journal: Pick<OwnedJournal<unknown, unknown, unknown, unknown, unknown, Y>, "admit">,
  input: StandardSchemaV1.InferInput<S>,
): Operation<StandardSchemaV1.InferOutput<S>, Y> {
  const result = yield* runtime.fromPromise(async () => tool.context["~standard"].validate(input));
  if (result.issues) {
    throw new Error("Tool input schema rejected value");
  }
  // Trusted journal binding stores the output of this program's schema.
  return (yield* journal.admit(tool.id, result.value)) as StandardSchemaV1.InferOutput<S>;
}
