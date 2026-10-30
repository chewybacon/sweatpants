import { toolFactory } from "../execution.ts";
import { toolImplementation } from "@sweatpants/agent-sdk/internal/tool-execution";
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
  const call = yield* toolFactory(ordinary)(ctx);
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

import { effection } from "@sweatpants/standard-durability-effection";

// Portable authoring keeps its concrete types through compilation and host binding.
import { createDurableTool as createPortableTool } from "../primitive-durable-create.ts";
import { createToolEffects } from "../tool-effect-middleware.ts";
import type { Operation as PortableOperation } from "@sweatpants/standard-durability";
import type { JournalRequest } from "../journal-compiler.ts";
import { success } from "@sweatpants/foundation/computation";

const portable = createPortableTool("portable-choice", { version: "1" })
  .description("Infer portable capabilities")
  .parameters(z.object({ count: z.string().transform(Number) }))
  .effects({
    double: {
      version: "1",
      input: z.object({ count: z.number() }),
      output: z.string().transform(Number),
      retrySafety: { mode: "repeatable" },
    },
  })
  .execute(function* (params, ctx) {
    expectTypeOf(params.count).toEqualTypeOf<number>();
    const doubled = yield* ctx.effect("double", params);
    expectTypeOf(doubled).toEqualTypeOf<number>();
    // @ts-expect-error undeclared effect names are rejected
    void ctx.effect("missing", params);
    // @ts-expect-error effect arguments use their declared input type
    void ctx.effect("double", { count: "2" });
    // @ts-expect-error sampling is not enabled
    void ctx.sample;
    return { doubled };
  });
expectTypeOf(portable.name).toEqualTypeOf<"portable-choice">();
expectTypeOf(toolImplementation(portable).invoke({}, "call")).toMatchTypeOf<
  PortableOperation<{ doubled: number }, JournalRequest>
>();
const transformed = createPortableTool("transformed", { version: "1" })
  .description("Preserve the output schema transform")
  .parameters(z.object({}))
  .output(z.string().transform(Number));
const transformedTool = transformed.execute(function* () {
  return "42";
});
expectTypeOf(toolImplementation(transformedTool).invoke({}, "call")).toMatchTypeOf<
  PortableOperation<number, JournalRequest>
>();
// @ts-expect-error the body returns raw schema input, not transformed output
transformed.execute(function* () {
  return 42;
});
createToolEffects(effection).handlers([portable])({
  *"portable-choice.double"(input) {
    expectTypeOf(input.count).toEqualTypeOf<number>();
    return success(String(input.count * 2));
  },
});
createToolEffects(effection).handlers([portable])({
  // @ts-expect-error handlers return raw output; transforming happens after acceptance
  *"portable-choice.double"() {
    return success(42);
  },
});
// @ts-expect-error every declared effect needs a handler
createToolEffects(effection).handlers([portable])({});

import { sleep } from "effection";
// @ts-expect-error portable bodies cannot capture a runtime-specific yielded protocol
transformed.execute(function* () {
  yield* sleep(1);
  return "42";
});
