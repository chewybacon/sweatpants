import { isDeepStrictEqual } from "node:util";
import type { Runtime } from "../../../../packages/v2/runtime/src/index.ts";
import type { CapabilityRequest } from "../../../../packages/v2/core/src/index.ts";
import type { OwnedJournal, ResolutionGrant } from "../../../../packages/v2/durable/src/index.ts";
import {
  createRecovery,
  createCheckpointMiddleware,
} from "../../../../packages/v2/durable/src/index.ts";
import {
  createHosting,
  createEffectCapabilities,
} from "../../../../packages/v2/hosting/src/index.ts";
import {
  createSchemeKernel,
  type SchemeMachine,
} from "../../../../packages/v2/codemode-runtime-scheme/src/index.ts";
import type { WorkflowModule } from "../../../../packages/v2/codemode-compiler/src/index.ts";
import { inspectLinkedCheckpoint, type LinkedReview } from "../linked.mjs";
import { bindEffectBoundary } from "../boundary.mts";
import { effects, requestSchema } from "../contract.mts";

// Experiment-local assembly, shared by the Worker and in-process acceptance.
// The caller owns command serialization and the journal/loader lifetimes.
export function createLinkedExecution<Y>(
  runtime: Runtime<Y>,
  options: {
    module: WorkflowModule;
    artifact: LinkedReview;
    input: string;
    journal: OwnedJournal<string, CapabilityRequest, unknown, unknown, unknown, Y>;
    loadMachine(): Promise<SchemeMachine>;
    counters: { starts: number; restores: number };
  },
) {
  const { journal, artifact } = options;
  const kernel = createSchemeKernel(runtime, {
    identity: artifact.identity,
    loadMachine: options.loadMachine,
    decodeRequest: bindEffectBoundary(
      options.module,
      Object.values(effects).map((effect) => effect.id),
    ),
    decodeResult(value) {
      if (typeof value !== "string") {
        throw new Error("Invalid result");
      }
      return value;
    },
  });
  return {
    *advance(command?: { grant: ResolutionGrant; value: unknown }) {
      const recipe = yield* kernel.prepare(artifact.source, options.input);
      const recovery = createRecovery(runtime.composition, {
        name: "linked",
        program: artifact.program,
        matches: isDeepStrictEqual,
        *acquire() {
          options.counters.starts++;
          return yield* recipe.acquire();
        },
      });
      yield* recovery.around(
        createCheckpointMiddleware({
          execution: recovery.execution,
          program: artifact.program,
          matches: isDeepStrictEqual,
          adapter: {
            ...recipe.checkpoints,
            *restore(state: unknown) {
              options.counters.restores++;
              return yield* recipe.checkpoints.restore(state);
            },
          },
        }),
      );
      const grant = createEffectCapabilities(runtime, "linked-effects").grant(effects);
      const host = createHosting(runtime.composition, {
        name: "linked-host",
        journal,
        recovery: recovery.operations,
        attempts: journal.attempts,
        interactions: journal.interactions,
        *handle() {
          throw new Error("Participant input required");
        },
      });
      yield* host.around(grant.admission);
      yield* host.around({
        *deliveryMode() {
          return "wait";
        },
      });
      if (command) {
        const request = yield* journal.interactions.request(command.grant);
        const outcome = yield* grant.respond(request, { ok: true, value: command.value });
        yield* host.operations.answer(command.grant, { ok: true, value: outcome });
      }
      // No attempt replacement and no model call. Existing hosting owns uncertainty.
      return yield* host.operations.run();
    },
    *read() {
      const state = yield* journal.read();
      const result =
        state.status === "completed"
          ? { state: "completed" as const, value: state.value }
          : state.status === "cancelled"
            ? { state: "cancelled" as const, reason: state.reason, failure: state.failure }
            : state.pending && state.interaction
              ? { ...state.interaction, pending: state.pending }
              : { state: "running" as const };
      // Only current registered questions produce answer controls, even if an old
      // checkpoint remains after acceptance but before explicit advancement.
      const question =
        result.state === "waiting"
          ? {
              message: requestSchema.parse(result.pending.request.input).message,
              choices:
                result.pending.request.effect === effects.approval.id
                  ? [
                      { label: "Approve draft", value: "yes" },
                      { label: "Decline", value: "no" },
                    ]
                  : result.pending.request.effect === effects.cleanup.id
                    ? [{ label: "Complete cleanup", value: "released" }]
                    : [],
            }
          : null;
      return {
        status: state.status,
        revision: state.revision,
        result,
        question,
        canAdvance: result.state === "running",
        inspection:
          state.status === "running" && state.pending && state.checkpoint
            ? inspectLinkedCheckpoint(artifact, state.checkpoint)
            : null,
      };
    },
  };
}
