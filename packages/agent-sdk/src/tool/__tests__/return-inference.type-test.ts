/** Compile-time contract: inferred results survive branches and delegation. */
import type { Operation } from "effection";
import { expectTypeOf } from "vitest";
import { z } from "zod";
import { createTool } from "../create.ts";
import { createDurableTool } from "../durable-create.ts";
import type { ToolCtx } from "../types.ts";
import type { DurableProgramContext } from "@sweatpants/durable-execution";

function* choose(accept: boolean) {
  if (accept) {
    return { status: "accepted" as const, count: 1 };
  }
  return { status: "declined" as const, reason: "No thanks" };
}
type Choice = ReturnType<typeof choose> extends Operation<infer R> ? R : never;

const ordinary = createTool("inferred-choice")
  .description("Choose")
  .parameters(z.object({ accept: z.boolean() }))
  .execute(function* ({ accept }) {
    return yield* choose(accept);
  });
const durable = createDurableTool("inferred-durable-choice", { version: "1" })
  .description("Choose")
  .parameters(z.object({ accept: z.boolean() }))
  .execute(function* ({ accept }) {
    return yield* choose(accept);
  });
const ready = createDurableTool("inferred-ready-choice", { version: "1" })
  .description("Choose with declared capabilities")
  .parameters(z.object({ accept: z.boolean() }))
  .samples()
  .execute(function* ({ accept }) {
    return yield* choose(accept);
  });

function* delegate(ctx: ToolCtx, durableCtx: DurableProgramContext) {
  const call = yield* ordinary(ctx);
  const result = yield* call({ accept: true });
  expectTypeOf(result).toEqualTypeOf<Choice>();
  if (result.status === "accepted") {
    expectTypeOf(result.count).toEqualTypeOf<number>();
  } else {
    expectTypeOf(result.reason).toEqualTypeOf<string>();
  }
  const durableResult = yield* durable.program({ accept: false }, durableCtx);
  expectTypeOf(durableResult).toMatchTypeOf<Choice>();
  if (durableResult.status === "accepted") {
    expectTypeOf(durableResult.count).toEqualTypeOf<number>();
  }
  const readyResult = yield* ready.program({ accept: true }, durableCtx);
  expectTypeOf(readyResult).toMatchTypeOf<Choice>();
}
void delegate;

const output = z.object({ status: z.enum(["accepted", "declined"]) });
const ordinaryWithOutput = createTool("explicit-choice")
  .description("Choose")
  .parameters(z.object({ accept: z.boolean() }))
  .output(output);
ordinaryWithOutput.execute(function* () {
  return { status: "accepted" as const };
});
// @ts-expect-error a declared output schema constrains the generator return
ordinaryWithOutput.execute(function* () {
  return { status: 42 };
});
// @ts-expect-error every returning branch must satisfy the declared output
ordinaryWithOutput.execute(function* ({ accept }) {
  if (accept) {
    return { status: "accepted" as const };
  }
  return "declined";
});
const durableWithOutput = createDurableTool("explicit-durable-choice", { version: "1" })
  .description("Choose")
  .parameters(z.object({}))
  .output(output);
durableWithOutput.execute(function* () {
  return { status: "accepted" as const };
});
// @ts-expect-error a declared output schema constrains the generator return
durableWithOutput.execute(function* () {
  return { status: 42 };
});
// @ts-expect-error the capability-ready builder preserves the output constraint
durableWithOutput.samples().execute(function* () {
  return "accepted";
});
// @ts-expect-error a forgotten return cannot satisfy a required output
durableWithOutput.execute(function* () {});

// Optional absent union properties are allowed; actual non-JSON values are not.
const jsonOnly = createDurableTool("json-only", { version: "1" })
  .description("Require portable output")
  .parameters(z.object({}));
// @ts-expect-error required undefined is not a JSON value
jsonOnly.execute(function* () {
  return { value: undefined };
});
// @ts-expect-error undefined array elements are not JSON values
jsonOnly.execute(function* () {
  return [undefined];
});
// @ts-expect-error nested functions cannot cross the durable boundary
jsonOnly.execute(function* () {
  return { callback: () => 1 };
});

// @ts-expect-error host objects are not portable JSON results
jsonOnly.execute(function* () {
  return new Date();
});
