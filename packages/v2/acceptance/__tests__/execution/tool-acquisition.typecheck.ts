import type { Operation } from "@standard-durability/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Guest } from "@sweatpan.ts/execution";
import { createEffectCapabilities } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createToolAcquisition, defineTool } from "@sweatpan.ts/tools";

/** Public consumer checked against source and emitted declarations. */
export function toolAcquisitionTypes<Y>(
  runtime: Runtime<Y>,
  schema: StandardSchemaV1<string, { query: string }>,
) {
  const tool = defineTool("typed-acquisition")
    .parameters(schema)
    .execute(function* (input) {
      return { length: input.query.length };
    });
  const effects = createEffectCapabilities(runtime, "typed-effects");
  const acquisition = createToolAcquisition(runtime, effects, tool, "typed-acquisition");
  const acquired: Operation<
    Guest<{ length: number }, CapabilityRequest, Y>,
    Y
  > = acquisition.operations.acquire({ query: "hello" });
  // @ts-expect-error Acquisition accepts normalized input, not schema caller input.
  acquisition.operations.acquire("hello");
  // @ts-expect-error The inferred tool result is preserved through the Guest.
  const wrong: Operation<Guest<string, CapabilityRequest, Y>, Y> = acquired;
  acquisition.around({
    *acquire([input], next) {
      const query: string = input.query;
      return yield* next({ query });
    },
  });
  return { acquired, wrong };
}
