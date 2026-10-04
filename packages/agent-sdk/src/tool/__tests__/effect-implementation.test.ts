import { expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import {
  durableEffectRuntimeSchemas,
  type DurableEffectContext,
} from "@sweatpants/durable-effects";
import { defineEffect, implementEffect } from "../durable-effect.ts";

it("binds a typed implementation without losing the authored validators or retry policy", async () => {
  const input = z.object({ count: z.number().int().min(1) });
  const output = z.string();
  const effect = defineEffect({
    name: "count",
    version: "1",
    input,
    output,
    retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
  });
  const registration = implementEffect(effect, function* (value, ctx) {
    return `${ctx.pullId}:${value.count}`;
  });
  expect(registration.definition).toBe(effect);
  expect(registration.satisfies).toEqual(effect.retrySafety);
  expect(durableEffectRuntimeSchemas(registration)).toMatchObject({ input, output });
  expect(
    await run(() =>
      registration.handler({ count: 2 }, { pullId: "stable" } as DurableEffectContext),
    ),
  ).toEqual({ status: "ok", value: "stable:2" });
});
