import type { DurableObjectHostOptions, DurableObjectHostMethods } from "./contracts.ts";
import type { Api, Composition } from "@standard-durability/core";

/** Per-alarm API with the application's advance and rethrowing settle as defaults. */
export function createDurableObjectHostApi<R, Q, V, E, Frame, Result, Y>(
  composition: Composition<Y>,
  advance: DurableObjectHostOptions<R, Q, V, E, Frame, Result, Y>["advance"],
): Api<DurableObjectHostMethods<R, Q, V, E, Frame, Result, Y>, Y> {
  return composition.createApi<DurableObjectHostMethods<R, Q, V, E, Frame, Result, Y>>(
    "durable-object-host",
    {
      advance: (run) => advance(run.journal, run.emit),
      *settle(outcome) {
        if (!outcome.ok) {
          throw outcome.error;
        }
      },
    },
  );
}
