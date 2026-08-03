import { defineEffect } from "@sweatpants/agent-sdk";
import { z } from "zod";
import type { Operation } from "effection";

export const ORDINARY_SERVER_SENTINEL = "ORDINARY_SERVER_IMPLEMENTATION_MUST_NOT_SHIP";
export const DURABLE_EFFECT_SENTINEL = "DURABLE_EFFECT_IMPLEMENTATION_MUST_NOT_SHIP";
export const DURABLE_EXECUTE_SENTINEL = "DURABLE_EXECUTE_IMPLEMENTATION_MUST_NOT_SHIP";

export function ordinaryServerExecute(): Operation<undefined> {
  return (function* () {
    void ORDINARY_SERVER_SENTINEL;
    return undefined;
  })();
}

export const durableServerEffect = defineEffect({
  name: DURABLE_EFFECT_SENTINEL,
  version: "1",
  input: z.object({}),
  output: z.object({}),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export function durableServerExecute(): Operation<string> {
  return (function* () {
    return DURABLE_EXECUTE_SENTINEL;
  })();
}
