import { assertUniqueElicitIds } from "./elicit-support.ts";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ElicitMetadata, ElicitPlugin, ElicitResponder } from "./contracts.ts";
import type { ResolvedElicitHandler } from "./types.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api } from "@standard-durability/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ToolAdmission } from "./contracts.ts";
import { admitTool } from "./admission.ts";

/** Scoped admission facade. Default normalization and pinning are the existing admitTool
 * operation. Replacement/short-circuit drivers are trusted and own those obligations. */
export function createToolAdmission<S extends StandardSchemaV1, Y>(
  runtime: Pick<Runtime<Y>, "fromPromise" | "composition">,
  name: string,
  tool: { readonly id: string; readonly context: S },
  journal: Pick<OwnedJournal<unknown, unknown, unknown, unknown, unknown, Y>, "admit">,
): Api<ToolAdmission<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, Y>, Y> {
  return runtime.composition.createApi<
    ToolAdmission<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, Y>
  >(name, {
    admit(input) {
      return admitTool(runtime, tool, journal, input);
    },
  });
}

/** Bind one declaration to runtime/frontend capabilities. The whole respond operation
 * is interceptable. Core dispatch validates context before constructing capabilities;
 * replacement/short-circuit middleware is trusted. No answer submission or task owner. */
export function createElicitResponder<
  L extends Record<string, EffectDefinition>,
  C extends object,
  Y,
>(
  runtime: Pick<Runtime<Y>, "composition" | "fromPromise">,
  name: string,
  plugin: ElicitPlugin<L, C, NoInfer<Y>>,
  capabilities: (interaction: ElicitMetadata) => C,
): Api<ElicitResponder<Y>, Y> {
  assertUniqueElicitIds(plugin.contract.elicits);
  return runtime.composition.createApi<ElicitResponder<Y>>(name, {
    *respond(selection, question) {
      const key = Object.keys(plugin.handlers).find(
        (name) =>
          plugin.contract.elicits[name]?.id === question.declaration.id &&
          Object.hasOwn(selection.routes, name) &&
          selection.routes[name] === "client",
      );
      if (
        question.program !== plugin.contract.id ||
        selection.tool !== plugin.support.tool ||
        key === undefined
      ) {
        throw new Error("No compatible local handler");
      }
      const declaration = plugin.contract.elicits[key];
      const interaction = Object.freeze({
        execution: question.execution,
        program: question.program,
        key,
        requestId: question.grant.requestId,
        resolutionId: question.grant.resolutionId,
      });
      const parsed = yield* runtime.fromPromise(async () =>
        declaration.context["~standard"].validate(question.input),
      );
      if (parsed.issues) {
        throw new Error("Invalid elicit context");
      }
      const handler = plugin.handlers[key] as ResolvedElicitHandler<C, Y>;
      return yield* handler(
        { context: parsed.value },
        Object.freeze({ ...capabilities(interaction), interaction }),
      );
    },
  });
}
