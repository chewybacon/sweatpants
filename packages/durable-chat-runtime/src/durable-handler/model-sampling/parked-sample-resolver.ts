import { CrankError, serializeDurableError } from "@sweatpants/durable-execution";
import { registerLiveDurablePull } from "@sweatpants/durable-effects/runtime";
import {
  encodeModelSampleResult,
  executeModelSamplePull,
  type ModelContextSource,
  type ModelSampleDisposition,
  type ModelSamplingService,
} from "@sweatpants/model-sampling";
import type { ModelContext } from "@sweatpants/model-provider";
import type { Operation } from "effection";
import {
  modelPullOwnerFence,
  PULL_KIND_SAMPLE,
  type PullResolutionContext,
  type PullResolver,
} from "@sweatpants/journal-authority";
import type { Json } from "@sweatpants/foundation";

function jsonRecord(value: Json | undefined): Record<string, Json> | undefined {
  // Narrowing the already-parsed `Json` union is the compiler's job, not a parser's.
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

export interface ParkedSampleService {
  readonly service: ModelSamplingService;
  readonly executor: "host" | "execution";
}

export interface ParkedSampleResolverDeps {
  /** Pull-fence service or deterministic placement selector. */
  readonly service:
    | ModelSamplingService
    | ((context: PullResolutionContext) => Operation<ParkedSampleService>);
  /** Journal identity evidence for the placement record. */
  readonly journalIdentity: () => Operation<{
    readonly id: string;
    readonly incarnation: string;
  }>;
  readonly sourceResolver: (source: ModelContextSource) => Operation<ModelContext>;
}

/**
 * Settles parked `sample` pulls outside any program scope. Placement evidence
 * arrives on the resolution context from the settle site whose activation
 * bound the owning attachment; this resolver never consults host-side
 * mutable state and refuses to run without it.
 */
export function createParkedSamplePullResolver(deps: ParkedSampleResolverDeps): PullResolver {
  return {
    kind: PULL_KIND_SAMPLE,
    audience: () => "model-runtime",
    *perform(ctx: PullResolutionContext, descriptor: Json) {
      const placement = ctx.placement;
      const sample = jsonRecord(descriptor);
      if (sample?.["kind"] !== PULL_KIND_SAMPLE || sample["input"] === undefined) {
        throw new CrankError("invalid_descriptor", "Sample resolver received another kind");
      }
      const selected = yield* serviceFor(deps.service, ctx);
      const attemptId = modelPullOwnerFence(ctx.pullId, placement.executionEpoch);
      const controller = new AbortController();
      const release = registerLiveDurablePull(
        ctx.sessionId,
        ctx.taskId,
        ctx.pullId,
        attemptId,
        (reason) => controller.abort(reason),
      );
      let disposition: ModelSampleDisposition;
      try {
        const journal = yield* deps.journalIdentity();
        disposition = yield* executeModelSamplePull({
          service: selected.service,
          executor: selected.executor,
          wireRequest: sample["input"],
          sessionId: ctx.sessionId,
          taskId: ctx.taskId,
          pullId: ctx.pullId,
          attemptId,
          cancellation: controller.signal,
          placement: {
            journal,
            program: placement.program,
            route: placement.route,
            driverKind: placement.driverKind,
          },
          sourceResolver: deps.sourceResolver,
        });
      } catch (error) {
        disposition = controller.signal.aborted
          ? { status: "cancelled" }
          : { status: "error", error: serializeDurableError(error) };
      } finally {
        release();
      }
      return disposition.status === "ok"
        ? { status: "ok" as const, value: encodeModelSampleResult(disposition.value) }
        : disposition;
    },
    *afterResolve(ctx, _descriptor, outcomeDigest) {
      const selected = yield* serviceFor(deps.service, ctx);
      if (selected.service.acknowledge) {
        try {
          yield* selected.service.acknowledge(
            { sessionId: ctx.sessionId, taskId: ctx.taskId, pullId: ctx.pullId },
            outcomeDigest,
          );
        } catch {
          // Authority acceptance is terminal; remote cleanup is retention-bounded.
        }
      }
    },
  };
}

function* serviceFor(
  configured: ParkedSampleResolverDeps["service"],
  context: PullResolutionContext,
): Operation<ParkedSampleService> {
  return typeof configured === "function"
    ? yield* configured(context)
    : { service: configured, executor: "host" };
}
