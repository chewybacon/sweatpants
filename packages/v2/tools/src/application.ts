import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api, Operation } from "@standard-durability/core";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type {
  ToolApplicationMethods,
  ToolApplicationOptions,
  ToolDefinition,
  ToolSession,
} from "./contracts.ts";
import { createToolSession } from "./session.ts";

/** Command facade over the same scoped session used by chat children. The caller
 * starts native work; existing context, port installations and middleware inherit. */
export function createToolApplication<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
  Y,
>(
  runtime: Runtime<Y>,
  tool: ToolDefinition<S, D, L, R>,
  options: ToolApplicationOptions<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>,
    NoInfer<R>,
    Y
  >,
): Api<ToolApplicationMethods<StandardSchemaV1.InferInput<S>, R, Y>, Y> {
  function invoke<T>(
    execution: string,
    work: (
      session: ToolSession<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, R, Y>,
    ) => Operation<T, Y>,
  ) {
    return runtime.composition.scoped(function* () {
      const journal = yield* options.open(execution);
      const stored = yield* journal.read();
      if (journal.id !== execution || stored.program !== tool.id) {
        throw new Error("Tool application journal does not match execution");
      }
      const session = createToolSession(runtime, tool, { ...options, journal });
      return yield* work(session);
    });
  }
  return runtime.composition.createApi<
    ToolApplicationMethods<StandardSchemaV1.InferInput<S>, R, Y>
  >(options.name, {
    start: (execution, input) => invoke(execution, (session) => session.start(input)),
    run: (execution) => invoke(execution, (session) => session.run()),
    read: (execution) =>
      invoke(execution, function* (session) {
        const { history: _history, ...snapshot } = yield* session.read();
        return snapshot;
      }),
    answer: (execution, grant, outcome) =>
      invoke(execution, (session) => session.answer(grant, outcome)),
  });
}
