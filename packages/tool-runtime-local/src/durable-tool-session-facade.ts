import { type DurableEffectHandler } from "@sweatpants/durable-effects";

import { scoped, type Operation } from "effection";
import { z } from "zod";
import { createTool, type RuntimeTool, type AnyToolContract } from "@sweatpants/agent-sdk";
import {
  AuthorityJournalPort,
  AuthoritySnapshotPort,
  JournalAuthorityPort,
  installStoredJournalAuthority,
  type CapabilityKeyring,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type JournalAuthorityContract,
  durableToolWorkflow,
  driveActivation,
  InstalledEffectPort,
  type HostAuthority,
  createPullResolverRegistry,
  PULL_KIND_ELICIT,
  PULL_KIND_FOREIGN,
  PULL_KIND_SAMPLE,
  type PullResolver,
} from "@sweatpants/journal-authority";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type {
  AppendEmissionRequest,
  CompleteTaskRequest,
  ResolveOperationRequest,
  ResolveOperationResult,
  ReserveOperationRequest,
  ReserveOperationResult,
  CompleteTaskResult,
} from "@sweatpants/journal-authority";
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { DURABLE_TOOL_FACADE_ANNOTATION } from "./durable-tool-facade-marker.ts";
import { executeForeignToolCall, type ForeignAskRelay } from "./foreign-tool-session.ts";
export {
  DURABLE_TOOL_FACADE_ANNOTATION,
  isDurableToolSessionFacade,
} from "./durable-tool-facade-marker.ts";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { AttachProgramRequest } from "@sweatpants/durable-execution";
import {
  assertReplayedCanonicalValue,
  stableProgramAttachmentId,
  exactProgramKey,
  type DurableTool,
  type DurableToolRegistry,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "@sweatpants/journal-authority/schema-registry";
import { type SchemaBinding } from "@sweatpants/foundation/schema";
import { ProgramRouteResolver } from "@sweatpants/durable-execution";

import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";

/** Expected facade failure translated through the ordinary ToolSession exception boundary. */
export class DurableToolFacadeError extends Error {
  readonly _tag = "DurableToolFacadeError";

  constructor(
    readonly code:
      | "program_failed"
      | "program_cancelled"
      | "unsupported_park"
      | "resolution_rejected"
      | "invalid_journal"
      | "program_version_unavailable"
      | "effect_handler_missing",
    message: string,
  ) {
    super(message);
    this.name = "DurableToolFacadeError";
  }
}

/** Invocation-keyed state port; implementations must copy snapshots and make saves retry-safe. */
export interface DurableToolFacadeStateStore {
  load(invocationId: string): Operation<DurableAuthoritySnapshot | undefined>;
  save(invocationId: string, snapshot: DurableAuthoritySnapshot): Operation<void>;
  delete(invocationId: string): Operation<void>;
}

type FacadeOuterContext = {
  /** Receives the raw model-sample request exactly as journaled. */
  sample?(request: Json): Operation<Json>;
  elicit(
    key: "foreign_input",
    request: { message: string; context: unknown },
  ): Operation<
    | { action: "accept"; content: unknown }
    | { action: "decline"; reason?: string }
    | { action: "cancel"; reason?: string }
  >;
};

/** Dependencies and hooks for exposing one crank-native tool through ToolSession. */
export interface DurableToolSessionFacadeOptions<I extends Json, O extends Json> {
  tool: DurableTool<I, O>;
  stateStore: DurableToolFacadeStateStore;
  keyring: CapabilityKeyring;
  name?: string;
  effectHandlers?: ReadonlyMap<string, DurableEffectHandler>;
  /** Runtime validators for low-level durable definitions. Core-authored tools
   * expose `artifacts.catalog` and are detected automatically. */
  /** Authored child programs available for automatic invocation composition. */
  children?: DurableToolRegistry;
  /**
   * Static pull resolvers supplied by the host — e.g. createForeignPullResolver
   * for session-bound live tools. Sample/elicit resolvers are built internally
   * from the tool's outer channels (REQ-009: no kind-shaped option bags).
   */
  pullResolvers?: readonly PullResolver[];
  schemaRegistry?: DurableSchemaRegistry;
  onActivation?: (evidence: {
    invocationId: string;
    activation: number;
    outcome: ProgramRunResult;
    journal: DurableSemanticRecord[];
  }) => Operation<void>;
}

/** Creates a process-local snapshot store suitable only for tests and non-durable hosts. */
export function createInMemoryDurableToolFacadeStateStore(): DurableToolFacadeStateStore {
  const snapshots = new Map<string, DurableAuthoritySnapshot>();
  return {
    *load(invocationId) {
      const snapshot = snapshots.get(invocationId);
      return snapshot ? structuredClone(snapshot) : undefined;
    },
    *save(invocationId, snapshot) {
      snapshots.set(invocationId, structuredClone(snapshot));
    },
    *delete(invocationId) {
      snapshots.delete(invocationId);
    },
  };
}

/**
 * Wraps a durable tool in the ordinary ToolSession protocol while retaining an
 * invocation-scoped inner journal. Expected execution failures cross the
 * ToolSession-required exception boundary as {@link DurableToolFacadeError}.
 */
export function createDurableToolSessionFacade<I extends Json, O extends Json>(
  options: DurableToolSessionFacadeOptions<I, O>,
): AnyToolContract {
  const name = options.name ?? options.tool.manifest.programId;
  return createTool(name)
    .description(
      `Ordinary ToolSession facade for durable program ${options.tool.manifest.programId}`,
    )
    .parameters(
      z.object({
        invocationId: z.string(),
        input: z.unknown(),
      }),
    )
    .elicits({
      foreign_input: {
        response: z.unknown(),
        context: z.unknown(),
      },
    })
    .samples()
    .annotate(DURABLE_TOOL_FACADE_ANNOTATION, { version: 1 })
    .execute(function* ({ invocationId, input }, context) {
      const validatedInput = assertManifestInput<I>(input);
      return yield* runFacadeProgram(
        options,
        invocationId,
        validatedInput,
        // The RuntimeTool context satisfies the facade's outer-channel shape;
        // `sample` is optional and only present when the host provides it.
        {
          ...(context.sample !== undefined
            ? {
                // Raw journaled request passes through opaquely; decode is
                // owned by the sampling layer, not the facade.
                sample: (request: Json) =>
                  context.sample(request as never) as unknown as Operation<Json>,
              }
            : {}),
          elicit: context.elicit,
        } as unknown as FacadeOuterContext,
      );
    });
}

/** Returns whether a runtime tool carries the durable-facade annotation. */

/** Adapts the journal-authority contract onto the drive loop's host surface. */
function hostAuthorityFor(authority: JournalAuthorityContract): HostAuthority {
  return {
    reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
      return authority.command({ type: "execution.reserve-pull", request });
    },
    resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
      return authority.command({ type: "execution.resolve-pull", request });
    },
    emit(request: AppendEmissionRequest): Operation<{ readonly offset: string }> {
      return authority.command({ type: "execution.append-emission", request });
    },
    complete(request: CompleteTaskRequest): Operation<CompleteTaskResult> {
      return authority.command({ type: "execution.complete-task", request });
    },
  };
}

/**
 * Installs the facade's effect implementations through the workflow
 * runtime's installed-effect port. Configured handlers win; model sampling
 * bridges to the outer context; anything else fails closed.
 */
function* installWorkflowEffectHandlers(
  sessionId: string,
  taskId: string,
  configured: ReadonlyMap<string, DurableEffectHandler> | undefined,
): Operation<void> {
  yield* InstalledEffectPort.installDriver({
    *run(descriptor, attempt) {
      const input = descriptor.input as Json;
      const context = {
        sessionId,
        taskId,
        pullId: attempt.pullId,
        attemptId: attempt.attemptId,
        cancellation: attempt.cancellation,
        resolver: descriptor.resolver,
      };
      const configuredHandler = configured?.get(descriptor.name);
      if (configuredHandler) {
        return yield* configuredHandler(input, context);
      }
      // Sampling knowledge belongs to whoever installs handlers; the facade
      // itself carries no model-sampling protocol.
      throw new DurableToolFacadeError(
        "effect_handler_missing",
        `No facade effect handler for ${descriptor.name}. Sampling requires a ` +
          `host-provided model.sample handler.`,
      );
    },
  });
}

function* runFacadeProgram<I extends Json, O extends Json>(
  options: DurableToolSessionFacadeOptions<I, O>,
  invocationId: string,
  input: I,
  outerContext: FacadeOuterContext,
): Operation<O> {
  let snapshot = yield* options.stateStore.load(invocationId);
  let activation = 0;
  const executionStore = createMemoryExecutionStore();
  const authoredCatalog = (
    options.tool as DurableTool<I, O> & {
      artifacts?: { catalog?: readonly SchemaBinding[] };
    }
  ).artifacts?.catalog;
  const schemaRegistry =
    options.schemaRegistry ??
    createDurableSchemaRegistry([...foreignToolSchemaEntries(), ...(authoredCatalog ?? [])]);
  const withAuthority = function* <T>(
    operation: (authority: JournalAuthorityContract) => Operation<T>,
  ): Operation<T> {
    return yield* scoped(function* () {
      yield* installExecutionStore(executionStore);
      yield* installStoredJournalAuthority({
        journalId: `durable-tool-facade:${options.tool.manifest.programId}`,
        journalIncarnation: "1",
        keyring: options.keyring,
        schemaRegistry,
        ...(snapshot ? { initialSnapshot: snapshot } : {}),
      });
      const authority = yield* JournalAuthorityPort.use();
      return yield* operation(authority);
    });
  };

  while (true) {
    const taskId = "turn-0/root";
    const attach = {
      sessionId: invocationId,
      taskId,
      program: {
        id: options.tool.manifest.programId,
        version: options.tool.manifest.version,
        digest: options.tool.manifest.digest,
      },
      input,
      route: { driverKind: "program" },
      executionEpoch: 1,
    };
    const activated = yield* runWorkflowActivation({
      options,
      invocationId,
      taskId,
      activation,
      input,
      snapshotExists: snapshot !== undefined,
      withAuthority,
    });
    const workflowOutcome = activated.outcome;
    activation += 1;
    snapshot = activated.snapshot;
    yield* options.stateStore.save(invocationId, snapshot);
    if (options.onActivation) {
      yield* options.onActivation({
        invocationId,
        activation,
        outcome: workflowOutcome,
        journal: activated.journal,
      });
    }
    if (workflowOutcome.state === "completed") {
      return assertReplayedCanonicalValue<O>(workflowOutcome.value as O);
    }
    if (workflowOutcome.state === "failed") {
      throw new DurableToolFacadeError("program_failed", workflowOutcome.error.message);
    }
    if (workflowOutcome.state === "cancelled") {
      throw new DurableToolFacadeError("program_cancelled", "Durable tool was cancelled");
    }
    if (workflowOutcome.state === "parked" && workflowOutcome.reason === "child") {
      if (!options.children) {
        throw new DurableToolFacadeError(
          "unsupported_park",
          "Child invocation without a configured child registry",
        );
      }
      yield* composeAuthoredChild(
        {
          invocationId,
          taskId,
          attach,
          pullId: workflowOutcome.pullId,
          children: options.children,
        },
        activated.journal,
        withAuthority,
      );
      continue;
    }
    if (workflowOutcome.state === "parked") {
      // Generic resolver dispatch: one find → perform → settle path for every
      // interaction kind; unregistered kinds fail closed (REQ-006/REQ-008).
      const pull = findPull(activated.journal, taskId, workflowOutcome.pullId);
      const resolver = facadePullResolvers(options, outerContext).get(workflowOutcome.reason);
      if (!resolver) {
        throw new DurableToolFacadeError(
          "unsupported_park",
          `Unsupported durable facade park reason: ${workflowOutcome.reason}`,
        );
      }
      const outcome = (yield* resolver.perform(
        { sessionId: invocationId, taskId, pullId: workflowOutcome.pullId },
        pull.descriptor,
      )) as OperationOutcome;
      yield* withAuthority(function* (authority) {
        const capability = yield* authority.query({
          type: "pull.resolution-capability",
          sessionId: invocationId,
          taskId,
          pullId: workflowOutcome.pullId,
        });
        const resolution = (yield* authority.command({
          type: "execution.resolve-pull",
          request: {
            capability,
            audience: resolver.audience(pull.descriptor),
            outcome,
          },
        })) as { status: string; code?: string };
        if (resolution.status === "rejected") {
          throw new DurableToolFacadeError(
            "resolution_rejected",
            (resolution as { code?: string }).code ?? "rejected",
          );
        }
        if (resolution.status === "rejected") {
          throw new DurableToolFacadeError("resolution_rejected", resolution.code ?? "rejected");
        }
      });
      continue;
    }
  }
}

function assertManifestInput<I extends Json>(input: unknown): I {
  return assertReplayedCanonicalValue<I>(input);
}

/** Generic unresolved-pull lookup feeding registry dispatch. */
function findPull(
  records: DurableSemanticRecord[],
  taskId: string,
  pullId: string,
): { kind: string; descriptor: Json } {
  const resolved = new Set(
    records.flatMap((r) => (r.payload.type === "PullResolved" ? [r.payload.pullId] : [])),
  );
  const record = records.find(
    (r) =>
      r.payload.type === "PullRequested" &&
      r.payload.taskId === taskId &&
      r.payload.pullId === pullId &&
      !resolved.has(r.payload.pullId),
  );
  if (!record || record.payload.type !== "PullRequested") {
    throw new DurableToolFacadeError("invalid_journal", "Parked pull missing from journal");
  }
  return {
    kind: record.payload.descriptor.kind,
    descriptor: record.payload.descriptor as unknown as Json,
  };
}

/**
 * Facade-side resolver registry: each interaction kind owns its transport;
 * dispatch is generic. Kinds ride kernel name constants — no host literals.
 */
/** Stock resolver for parked `foreign` pulls over host-supplied live tools. */
export function createForeignPullResolver(statics: {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly asks?: ForeignAskRelay;
}): PullResolver {
  return {
    kind: PULL_KIND_FOREIGN,
    audience: (descriptor) => `foreign:${(descriptor as { driver: string }).driver}`,
    perform(ctx, descriptor) {
      const d = descriptor as { driver: string; tool: string; input: Json };
      return executeForeignToolCall(
        { tools: statics.tools as Map<string, RuntimeTool> },
        {
          driver: d.driver,
          tool: d.tool,
          input: d.input,
          durability: "ephemeral_handle",
        },
        ctx,
        statics.asks,
      );
    },
  };
}

function facadePullResolvers(
  options: { readonly pullResolvers?: readonly PullResolver[] },
  outerContext: FacadeOuterContext,
): ReadonlyMap<string, PullResolver> {
  return createPullResolverRegistry([
    ...(options.pullResolvers ?? []),
    {
      kind: PULL_KIND_SAMPLE,
      audience: () => "model-runtime",
      *perform(_ctx, descriptor) {
        if (!outerContext.sample) {
          throw new DurableToolFacadeError(
            "unsupported_park",
            "Program sampled for a model but no outer sampler is configured",
          );
        }
        const sampled = yield* outerContext.sample((descriptor as { input: Json }).input);
        // Rich tool results carry undefined optional members; journals hold
        // canonical JSON, so strip them before settling the pull.
        return {
          status: "ok" as const,
          value: JSON.parse(JSON.stringify(sampled ?? null)) as Json,
        };
      },
    },
    {
      kind: PULL_KIND_ELICIT,
      audience: (descriptor) => `user:${(descriptor as { key: string }).key}`,
      *perform(_ctx, descriptor) {
        const d = descriptor as {
          message: string;
          key: string;
          response: { inputProjection: Json };
          context?: Json;
        };
        const elicitResponse = yield* outerContext.elicit("foreign_input", {
          message: d.message,
          context: {
            key: d.key,
            responseSchema: d.response.inputProjection,
            ...(d.context !== undefined ? { context: d.context } : {}),
          },
        });
        return {
          status: "ok" as const,
          value:
            elicitResponse.action === "accept"
              ? { action: "accept", content: assertJson(elicitResponse.content) }
              : {
                  action: elicitResponse.action,
                  ...(elicitResponse.reason !== undefined ? { reason: elicitResponse.reason } : {}),
                },
        };
      },
    },
  ]);
}

/** Locates one unresolved invoke pull proposed by the root task. */
function findInvokePull(
  records: DurableSemanticRecord[],
  taskId: string,
  pullId: string,
): { child: { id: string; version: string; digest: string; input: Json } } | undefined {
  const resolved = new Set(
    records.flatMap((r) => (r.payload.type === "PullResolved" ? [r.payload.pullId] : [])),
  );
  const pull = records.find(
    (r) =>
      r.payload.type === "PullRequested" &&
      r.payload.taskId === taskId &&
      r.payload.pullId === pullId &&
      !resolved.has(r.payload.pullId) &&
      r.payload.descriptor.kind === "invoke",
  );
  if (!pull || pull.payload.type !== "PullRequested") return undefined;
  if (pull.payload.descriptor.kind !== "invoke") return undefined;
  return { child: pull.payload.descriptor.child as never };
}

interface ComposeRequest {
  readonly invocationId: string;
  readonly taskId: string;
  readonly attach: AttachProgramRequest;
  readonly pullId: string;
  readonly children: DurableToolRegistry;
  /** Reserved for foreign-call orchestration once session resolution lands. */
  readonly foreignRequest?: undefined;
}

/**
 * Composes one parked authored-child invocation: ensure-child, bind, and a
 * nested activation that closes the child against its own journal. The next
 * facade activation restores the parent against the settled invocation.
 */
function* composeAuthoredChild(
  request: ComposeRequest,
  journal: DurableSemanticRecord[],
  withAuthority: <T>(
    operation: (authority: JournalAuthorityContract) => Operation<T>,
  ) => Operation<T>,
): Operation<void> {
  const { invocationId, taskId, attach, pullId, children } = request;
  const pull = findInvokePull(journal, taskId, pullId);
  if (!pull) {
    throw new DurableToolFacadeError("invalid_journal", "Child pull missing from journal");
  }
  const childTool = children.get(exactProgramKey(pull.child));
  if (!childTool) {
    throw new DurableToolFacadeError(
      "program_version_unavailable",
      `No child program for ${exactProgramKey(pull.child)}`,
    );
  }
  yield* withAuthority(function* (authority) {
    const routeResolver = yield* ProgramRouteResolver.use();
    const childRoute = yield* routeResolver.resolve({
      program: pull.child,
      parentRoute: attach.route,
    });
    const childTask = yield* authority.command({
      type: "execution.ensure-child",
      request: {
        sessionId: invocationId,
        turnId: "turn-0",
        parentTaskId: taskId,
        parentPullId: pullId,
        child: pull.child,
        manifest: childTool.manifest,
        executionEpoch: attach.executionEpoch,
        audience: "program-runtime",
        route: childRoute,
      },
    });
    const childRequest: AttachProgramRequest = {
      sessionId: invocationId,
      taskId: childTask.taskId,
      program: {
        id: pull.child.id,
        version: pull.child.version,
        digest: pull.child.digest,
      },
      input: pull.child.input,
      route: childRoute,
      executionEpoch: attach.executionEpoch,
    };
    const bound = yield* authority.command({
      type: "execution.bind-attachment",
      request: {
        sessionId: invocationId,
        taskId: childTask.taskId,
        attachmentId: stableProgramAttachmentId(childRequest),
        executionEpoch: attach.executionEpoch,
      },
    });
    // The composed child closes itself; restoring the parent is the caller's
    // next activation.
    yield* driveActivation({
      attach: childRequest,
      authority: hostAuthorityFor(authority),
      programCapability: bound.programCapability,
      workflow: durableToolWorkflow(childTool, pull.child.input),
    });
  });
}

interface WorkflowActivationRequest<I extends Json> {
  readonly options: DurableToolSessionFacadeOptions<I, Json>;
  readonly invocationId: string;
  readonly taskId: string;
  readonly activation: number;
  readonly input: I;
  readonly snapshotExists: boolean;
  readonly withAuthority: <T>(
    operation: (authority: JournalAuthorityContract) => Operation<T>,
  ) => Operation<T>;
}

interface WorkflowActivationResult {
  readonly outcome: ProgramRunResult;
  readonly snapshot: DurableAuthoritySnapshot;
  readonly journal: DurableSemanticRecord[];
}

/**
 * One workflow-runtime activation: open or bind by snapshot presence, install
 * effect handlers, drive the attachment to park or terminal, and export the
 * post-activation snapshot and journal.
 */
function* runWorkflowActivation<I extends Json>(
  request: WorkflowActivationRequest<I>,
): Operation<WorkflowActivationResult> {
  const { options, invocationId, taskId, activation, input } = request;
  return yield* request.withAuthority(function* (authority): Operation<WorkflowActivationResult> {
    let programCapability: string;
    if (!request.snapshotExists) {
      const openedTask = yield* authority.command({
        type: "execution.open-task",
        request: {
          sessionId: invocationId,
          turnId: "turn-0",
          taskId,
          manifest: options.tool.manifest,
          input,
          executionEpoch: 1,
          attachmentId: "unattached-facade-program",
          audience: "program-runtime",
        },
      });
      programCapability = openedTask.programCapability;
    } else {
      const bound = yield* authority.command({
        type: "execution.bind-attachment",
        request: {
          sessionId: invocationId,
          taskId,
          attachmentId: `unattached-facade-program-${activation}`,
          executionEpoch: 1,
        },
      });
      programCapability = bound.programCapability;
    }
    yield* installWorkflowEffectHandlers(invocationId, taskId, options.effectHandlers);
    const outcome: ProgramRunResult = yield* driveActivation({
      attach: {
        sessionId: invocationId,
        taskId,
        program: {
          id: options.tool.manifest.programId,
          version: options.tool.manifest.version,
          digest: options.tool.manifest.digest,
        },
        input,
        route: { driverKind: "program" },
        executionEpoch: 1,
      },
      workflow: durableToolWorkflow(options.tool, input),
      authority: hostAuthorityFor(authority),
      programCapability,
    });
    const snapshotPort = yield* AuthoritySnapshotPort.use();
    const journalPort = yield* AuthorityJournalPort.use();
    return {
      outcome,
      snapshot: yield* snapshotPort.exportSnapshot(),
      journal: [...(yield* journalPort.readSession(invocationId))],
    };
  });
}
