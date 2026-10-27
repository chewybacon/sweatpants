import type { CheckpointAdapter } from "@sweatpan.ts/codemode-runtime";
import type { GuestWork } from "@sweatpan.ts/execution";

export interface LuaEvaluator<R, Q, Y> {
  readonly acquire: GuestWork<R, Q, Y>;
  readonly checkpoints: CheckpointAdapter<R, Q, Y, unknown, unknown, unknown>;
}
