import type { Work } from "@standard-durability/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createToolAcquisition } from "./acquisition.ts";
import { createToolAdmission } from "./apis.ts";
import { installElicitHandlers } from "./middleware.ts";
import type { ToolDefinition, ToolSession, ToolSessionOptions } from "./contracts.ts";

/** Shared direct-tool/chat-child assembly. Construction acquires nothing. */
export function createToolSession<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
  Y,
>(
  runtime: Runtime<Y>,
  tool: ToolDefinition<S, D, L, R>,
  options: ToolSessionOptions<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>,
    NoInfer<R>,
    Y
  >,
): ToolSession<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>, R, Y> {
  const { journal, child } = options;
  if (child && (child.program !== tool.id || child.childId !== journal.id)) {
    throw new Error("Tool child does not match session");
  }
  const name = `tool:${journal.id}`;
  const effects = createEffectCapabilities(runtime, name);
  const acquisition = createToolAcquisition(runtime, effects, tool, `${name}:acquire`);
  const admission = createToolAdmission(runtime, `${name}:admit`, tool, journal);
  const recovery = (
    options.recovery ?? ((config) => createRecovery(runtime.composition, config))
  )<R>({
    name: `${name}:recover`,
    program: tool.id,
    matches: options.matches,
    *acquire() {
      const stored = yield* journal.read();
      if (stored.program !== tool.id || (!stored.admission && !child)) {
        throw new Error("Tool execution requires matching admitted input");
      }
      return yield* acquisition.operations.acquire(
        (child ? child.input : stored.admission!.input) as StandardSchemaV1.InferOutput<S>,
      );
    },
  });
  const host = createHosting(runtime.composition, {
    name: `${name}:host`,
    journal,
    recovery: recovery.operations,
    interactions: journal.interactions,
    attempts: journal.attempts,
    handle: acquisition.handle,
  });
  const session: ToolSession<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>,
    R,
    Y
  > = {
    journal,
    admission,
    effects,
    acquisition,
    recovery,
    host,
    start(input) {
      return configured(function* () {
        if (child) {
          throw new Error("Owned tool input is admitted by its parent");
        }
        yield* admission.operations.admit(input);
        return yield* host.operations.run();
      });
    },
    read: () => configured(() => journal.read()),
    run: () => configured(() => host.operations.run()),
    answer(grant, outcome) {
      return configured(function* () {
        const ingress = yield* installEffectAnswers(
          host,
          effects.grant(tool.elicits),
          journal.interactions,
        );
        return yield* ingress.answer(grant, outcome);
      });
    },
  };
  function configured<T>(work: Work<T, Y>) {
    return runtime.composition.scoped(function* () {
      const stored = yield* journal.read();
      if (stored.program !== tool.id) {
        throw new Error("Tool session program does not match journal");
      }
      yield* installGuestRetention(runtime.composition, host, recovery, journal);
      yield* host.around(acquisition.admission);
      yield* installElicitHandlers(host, effects, tool);
      if (options.configure) {
        yield* options.configure(session);
      }
      return yield* work();
    });
  }
  return session;
}
