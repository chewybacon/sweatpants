import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api } from "@standard-durability/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ToolAdmission } from "./contracts.ts";
import { admitTool } from "./admission.ts";
/** Scoped admission facade. Default normalization and pinning are the existing admitTool
 * operation. Replacement/short-circuit drivers are trusted and own those obligations. */
export function createToolAdmission<S extends StandardSchemaV1, Y>(
  runtime: Pick<Runtime<Y>, "fromPromise" | "composition">,
  name: string,
  tool: {
    readonly id: string;
    readonly context: S;
  },
  journal: Pick<OwnedJournal<unknown, unknown, unknown, unknown, unknown, Y>, "admit">,
): Api<ToolAdmission<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, Y>, Y> {
  return runtime.composition.createApi<
    ToolAdmission<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, Y>
  >(name, {
    operations: {
      admit(input) {
        return admitTool(runtime, tool, journal, input);
      },
    },
  });
}
