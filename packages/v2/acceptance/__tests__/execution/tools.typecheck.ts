import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createEffectCapabilities } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { defineTool } from "@sweatpan.ts/tools";

// Non-executed consumer checked against source and emitted declarations.
export function toolInference<Y>(
  runtime: Runtime<Y>,
  schema: StandardSchemaV1<string, { text: string }>,
) {
  const question = defineEffect({ key: "question", context: schema, response: schema });
  const tool = defineTool("inspect")
    .parameters(schema)
    .elicits({ question })
    .execute(function* (input, ctx) {
      const text: string = yield* ctx.await(
        async (signal) => {
          const aborted: boolean = signal.aborted;
          return aborted ? "aborted" : input.text;
        },
        { record: {} },
      );
      // @ts-expect-error Unrecorded Promise execution is deferred.
      ctx.await(async () => input.text);
      // @ts-expect-error A factory is required so recording controls execution.
      ctx.await(Promise.resolve(input.text), { record: {} });
      const reply = yield* ctx.elicit("question", text);
      // @ts-expect-error Only declared elicitation keys are accepted.
      ctx.elicit("missing", text);
      // @ts-expect-error Elicitation callers supply schema input.
      ctx.elicit("question", { text });
      // @ts-expect-error No capabilities have been declared.
      ctx.capabilities.read(text);
      yield* ctx.scope.ensure(function* () {});
      return { text, reply };
    });
  type Result = { text: string; reply: Outcome<{ text: string }, unknown> };
  const call: Operation<Outcome<Result, never>, CapabilityRequest> = tool.call("query");
  // @ts-expect-error Caller input is distinct from normalized body input.
  tool.call({ text: "query" });
  // @ts-expect-error Result inference survives the public builder.
  const wrong: Operation<Outcome<number, never>, CapabilityRequest> = tool.call("query");
  const effects = createEffectCapabilities(runtime, "tools");
  const grant = effects.grant({ tool }, { record: true });
  const granted: Operation<Outcome<Result, never>, CapabilityRequest> = grant.capabilities.tool(
    "query",
  );
  defineTool("native")
    .parameters(schema)
    // @ts-expect-error Native host work is not a tool-body instruction.
    .execute(function* () {
      return yield* runtime.fromPromise(async () => 1);
    });
  return { call, wrong, granted };
}
