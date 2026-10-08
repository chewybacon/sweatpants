import type { DurableEffectHandler } from "@sweatpants/durable-effects";

import { scoped, type Operation } from "effection";
import type { ChatMessage } from "@sweatpants/chat-contract";
import { z } from "zod";
import {
  createTool,
  type AnyToolContract,
  type RuntimeTool,
  type ToolSampleConfig,
} from "@sweatpants/agent-sdk";
import {
  createJournal,
  installJournal,
  useJournal,
  type Journal,
  type CapabilityKeyring,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  durableToolWorkflow,
  driveActivation,
  InstalledEffectPort,
  createPullResolverRegistry,
  PULL_KIND_ELICIT,
  PULL_KIND_EPHEMERAL,
  PULL_KIND_SAMPLE,
  type PullResolver,
} from "@sweatpants/journal-authority";
import { ExecutionStorePort, installExecutionStore } from "@sweatpants/journal-authority/api";
import { DURABLE_TOOL_FACADE_ANNOTATION } from "@sweatpants/tool-session/execution";
import {
  executeEphemeralToolCall,
  type EphemeralAskRelay,
} from "@sweatpants/tool-session/execution";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import {
  assertReplayedCanonicalValue,
  ProgramRouteResolver,
  exactProgramKey,
  type AttachProgramRequest,
  type DurableTool,
  type DurableToolRegistry,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "@sweatpants/journal-authority/schema-registry";
import type { SchemaBinding } from "@sweatpants/foundation/schema";

import { ephemeralToolSchemaEntries } from "@sweatpants/tool-session/ephemeral";

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
    key: "ephemeral_input",
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
   * Static pull resolvers supplied by the host — e.g. createEphemeralPullResolver
   * for session-bound live tools. Sample/elicit resolvers are built internally
   * from the tool's outer channels (REQ-009: no kind-shaped option bags).
   */
  pullResolvers?: readonly PullResolver[];
  schemaRegistry?: DurableSchemaRegistry;
  onActivation?: (evidence: {
    invocationId: string;
    activation: number;
    outcome: AdvancementResult;
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
      ephemeral_input: {
        response: z.unknown(),
        context: z.unknown(),
      },
    })
    .samples()
    .annotate(DURABLE_TOOL_FACADE_ANNOTATION, { version: 1 })
    .execute(function* ({ invocationId, input }, context) {
      const validatedInput = assertManifestInput<I>(input);
      return yield* runFacadeProgram(options, invocationId, validatedInput, {
        ...(context.sample === undefined
          ? {}
          : {
              *sample(request: Json): Operation<Json> {
                const sampled = yield* context.sample(facadeSampleRequest(request));
                return assertJson(JSON.parse(JSON.stringify(sampled ?? null)));
              },
            }),
        *elicit(_key, request) {
          return yield* context.elicit("ephemeral_input", request);
        },
      });
    });
}

/** Returns whether a runtime tool carries the durable-facade annotation. */

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
        return assertJson(yield* configuredHandler(input, context));
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
  // Invocation ownership isolates its store and journal from sibling tool calls.
  return yield* scoped(function* () {
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
      createDurableSchemaRegistry([...ephemeralToolSchemaEntries(), ...(authoredCatalog ?? [])]);
    yield* installExecutionStore(executionStore);
    const ownedJournal = yield* createJournal(ExecutionStorePort.api.operations, {
      journalId: `durable-tool-facade:${options.tool.manifest.programId}`,
      journalIncarnation: "1",
      keyring: options.keyring,
      schemaRegistry,
      initialSnapshot: snapshot,
    });
    yield* installJournal(ownedJournal);
    const journal = yield* useJournal();

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
        journal,
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
          journal,
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
        const outcome = yield* resolver.perform(
          {
            sessionId: invocationId,
            taskId,
            pullId: workflowOutcome.pullId,
            placement: {
              program: attach.program,
              route: attach.route,
              driverKind: "workflow",
              executionEpoch: attach.executionEpoch,
            },
          },
          pull.descriptor,
        );
        const capability = yield* journal.query({
          type: "pull.resolution-capability",
          sessionId: invocationId,
          taskId,
          pullId: workflowOutcome.pullId,
        });
        const resolution = (yield* journal.advance({
          type: "execution.resolve-pull",
          request: {
            capability,
            audience: resolver.audience(pull.descriptor),
            outcome,
          },
        })) as { status: string; code?: string };
        if (resolution.status === "rejected") {
          throw new DurableToolFacadeError("resolution_rejected", resolution.code ?? "rejected");
        }
        continue;
      }
    }
  });
}

const facadeSampleRequestSchema = z.union([
  z.object({ prompt: z.string() }).passthrough(),
  z.object({ messages: z.array(z.unknown()) }).passthrough(),
]);

function facadeSampleRequest(request: Json): ToolSampleConfig<ChatMessage> {
  const parsed = facadeSampleRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new DurableToolFacadeError(
      "unsupported_park",
      "Facade sampling requires a prompt or messages request",
    );
  }
  return parsed.data as unknown as ToolSampleConfig<ChatMessage>;
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
    descriptor: assertJson(record.payload.descriptor),
  };
}

/**
 * Facade-side resolver registry: each interaction kind owns its transport;
 * dispatch is generic. Kinds ride kernel name constants — no host literals.
 */
/** Stock resolver for parked `ephemeral` pulls over host-supplied live tools. */
export function createEphemeralPullResolver(statics: {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly asks?: EphemeralAskRelay;
}): PullResolver {
  return {
    kind: PULL_KIND_EPHEMERAL,
    audience: (descriptor) => `ephemeral:${(descriptor as { driver: string }).driver}`,
    perform(ctx, descriptor) {
      const d = descriptor as { driver: string; tool: string; input: Json };
      return executeEphemeralToolCall(
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
        const elicitResponse = yield* outerContext.elicit("ephemeral_input", {
          message: d.message,
          context: {
            key: d.key,
            responseSchema: d.response.inputProjection,
            ...(d.context !== undefined ? { context: d.context } : {}),
          },
        });
        const value: Json =
          elicitResponse.action === "accept"
            ? { action: "accept", content: assertJson(elicitResponse.content) }
            : {
                action: elicitResponse.action,
                ...(elicitResponse.reason !== undefined ? { reason: elicitResponse.reason } : {}),
              };
        return { status: "ok" as const, value };
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
  if (!pull || pull.payload.type !== "PullRequested") {
    return undefined;
  }
  if (pull.payload.descriptor.kind !== "invoke") {
    return undefined;
  }
  return { child: pull.payload.descriptor.child };
}

interface ComposeRequest {
  readonly invocationId: string;
  readonly taskId: string;
  readonly attach: AttachProgramRequest;
  readonly pullId: string;
  readonly children: DurableToolRegistry;
}

/**
 * Composes one parked authored-child invocation: ensure-child, bind, and a
 * nested activation that closes the child against its own journal. The next
 * facade activation restores the parent against the settled invocation.
 */
function* composeAuthoredChild(
  request: ComposeRequest,
  records: DurableSemanticRecord[],
  journal: Journal,
): Operation<void> {
  const { invocationId, taskId, attach, pullId, children } = request;
  const pull = findInvokePull(records, taskId, pullId);
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
  yield* scoped(function* () {
    const routeResolver = yield* ProgramRouteResolver.use();
    const childRoute = yield* routeResolver.resolve({
      program: pull.child,
      parentRoute: attach.route,
    });
    const childTask = yield* journal.advance({
      type: "execution.ensure-child",
      request: {
        sessionId: invocationId,
        turnId: "turn-0",
        parentTaskId: taskId,
        parentPullId: pullId,
        child: pull.child,
        manifest: childTool.manifest,
        executionEpoch: attach.executionEpoch,
        audience: "workflow-host",
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
    // The composed child closes itself; restoring the parent is the caller's
    // next activation.
    yield* driveActivation({
      attach: childRequest,
      authority: { command: journal.advance, query: journal.query },
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
  readonly journal: Journal;
}

interface WorkflowActivationResult {
  readonly outcome: AdvancementResult;
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
  const { options, invocationId, taskId, input, journal } = request;
  // Each activation owns its effect installation and workflow children. The
  // journal belongs to the enclosing invocation and survives durable parks.
  return yield* scoped(function* (): Operation<WorkflowActivationResult> {
    if (!request.snapshotExists) {
      yield* journal.advance({
        type: "execution.open-task",
        request: {
          sessionId: invocationId,
          turnId: "turn-0",
          taskId,
          manifest: options.tool.manifest,
          input,
          executionEpoch: 1,
          attachmentId: "unattached-facade-program",
          audience: "workflow-host",
        },
      });
    }
    yield* installWorkflowEffectHandlers(invocationId, taskId, options.effectHandlers);
    const outcome: AdvancementResult = yield* driveActivation({
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
      authority: { command: journal.advance, query: journal.query },
    });
    return {
      outcome,
      snapshot: yield* journal.exportSnapshot(),
      journal: [...(yield* journal.readSession(invocationId))],
    };
  });
}
