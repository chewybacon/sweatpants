import type { Operation } from "../../../packages/v2/runtime/src/index.ts";
import { isDeepStrictEqual } from "node:util";
import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";
import {
  createRecovery,
  createCheckpointMiddleware,
  type OwnedJournal,
  type ResolutionGrant,
} from "../../../packages/v2/durable/src/index.ts";
import { createHosting, createEffectCapabilities } from "../../../packages/v2/hosting/src/index.ts";
import type { PreparedProgram } from "../../../packages/v2/execution/src/index.ts";
import type { Runtime } from "../../../packages/v2/runtime/src/index.ts";
import type { ModelProvider } from "../../../packages/v2/providers/src/index.ts";
import { sample, sampleSchema, movePlan, move, declarations } from "./contracts.mts";
import { sampleStream, type SampleModel } from "./provider.mts";

import { sampleSchemaStream } from "./structured.mts";

export function createSamplingHost<Y>(
  runtime: Runtime<Y>,
  options: {
    program: string;
    journal: OwnedJournal<string, CapabilityRequest, unknown, unknown, unknown, Y>;
    prepare(): Operation<PreparedProgram<string, CapabilityRequest, Y>, Y>;
    model: SampleModel;
    provider: ModelProvider<Y>;
  },
) {
  return {
    *run(command?: { grant: ResolutionGrant; value: unknown } | { cancel: string }) {
      // prepare is a normal Operation; each activation owns its recipe and host scope.
      const recipe = yield* options.prepare();
      const registry = createEffectCapabilities(runtime, "sampling-capabilities");
      yield* registry.install(sample, function* (request) {
        const stream = yield* sampleStream(options.provider, options.model, request);
        while (true) {
          const item = yield* stream.next();
          if (item.done) {
            return { ok: true as const, value: item.value };
          }
          // Provisional events stay on the provider stream, never in accepted history.
        }
      });
      yield* registry.install(sampleSchema, function* (request) {
        const stream = yield* sampleSchemaStream(
          options.provider,
          options.model,
          request,
          movePlan,
        );
        while (true) {
          const item = yield* stream.next();
          if (item.done) {
            return { ok: true as const, value: item.value };
          }
        }
      });
      const grant = registry.grant(declarations);
      const recovery = createRecovery(runtime.composition, {
        name: "sampling-recovery",
        program: options.program,
        matches: isDeepStrictEqual,
        acquire: recipe.acquire,
      });
      if (recipe.checkpoints) {
        yield* recovery.around(
          createCheckpointMiddleware({
            execution: recovery.execution,
            program: options.program,
            matches: isDeepStrictEqual,
            adapter: recipe.checkpoints,
          }),
        );
      }
      const host = createHosting(runtime.composition, {
        name: "sampling-host",
        journal: options.journal,
        recovery: recovery.operations,
        attempts: options.journal.attempts,
        interactions: options.journal.interactions,
        handle: grant.handle,
      });
      yield* host.around(grant.admission);
      yield* host.around({
        *deliveryMode([request]) {
          return request.effect === move.id ? "wait" : "execute";
        },
        *retrySafety() {
          return "unsafe";
        },
      });
      if (command && "grant" in command) {
        const request = yield* options.journal.interactions.request(command.grant);
        const outcome = yield* grant.respond(request, { ok: true, value: command.value });
        // Match defineEffect.call and grant.handle: successful delivery carries a
        // domain Outcome. Scheme and typed tool authoring see the same envelope.
        yield* host.operations.answer(command.grant, { ok: true, value: outcome });
      } else if (command) {
        yield* host.operations.cancel(command.cancel, "player stopped");
      }
      return yield* host.operations.run();
    },
  };
}
