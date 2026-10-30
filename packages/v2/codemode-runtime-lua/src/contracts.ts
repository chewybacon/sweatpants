import type { CheckpointAdapter, GuestWork } from "@sweatpan.ts/execution";
import type { CapabilityRequest } from "@sweatpan.ts/core";

/** Immutable Lua-name bindings; decoding does not grant authority or execute schemas. */
export interface LuaEffectBindings {
  /**
   * Decode the VM's { site, request: { effect, input } } exchange envelope.
   * Unknown names and malformed envelopes reject before journal admission.
   * Input remains raw for the granted host's context schema at delivery.
   */
  decodeRequest(value: unknown): CapabilityRequest;
}

export interface LuaEvaluator<R, Q, Y> {
  readonly acquire: GuestWork<R, Q, Y>;
  readonly checkpoints: CheckpointAdapter<R, Q, Y, unknown, unknown, unknown>;
}
