import {
  type DurableEffectHandler,
  type DurableEffectRegistration,
} from "@sweatpants/durable-effects";

import { scoped, type Operation } from "effection";
import { z } from "zod";
import { createTool, type AnyToolContract } from "@sweatpants/agent-sdk";
import {
  AuthorityJournalPort,
  AuthoritySnapshotPort,
  JournalAuthorityPort,
  installJournalProgramRuntime,
  installStoredJournalAuthority,
  type CapabilityKeyring,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type JournalAuthorityContract,
} from "@sweatpants/journal-authority";
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import {
  assertReplayedCanonicalValue,
  createDurableToolRegistry,
  type DurableProgramManifest,
  type DurableTool,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "@sweatpants/journal-authority/schema-registry";
import { type SchemaBinding } from "@sweatpants/foundation/schema";
import {
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
} from "@sweatpants/durable-execution";

import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";
import { createLocalDurableProgramDriver } from "./durable-driver.ts";

/** Runtime annotation identifying an ordinary tool backed by an inner durable journal. */
export const DURABLE_TOOL_FACADE_ANNOTATION = "sweatpants/durable-tool-facade";

/** Expected facade failure translated through the ordinary ToolSession exception boundary. */
export class DurableToolFacadeError extends Error {
  readonly _tag = "DurableToolFacadeError";

  constructor(
    readonly code:
      | "program_failed"
      | "program_cancelled"
      | "unsupported_park"
      | "resolution_rejected"
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
  sample(request: { prompt: string }): Operation<{
    text: string;
    model?: string;
    stopReason?: string;
  }>;
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
      return yield* runFacadeProgram(options, invocationId, validatedInput, context);
    });
}

/** Returns whether a runtime tool carries the durable-facade annotation. */
export function isDurableToolSessionFacade(tool: AnyToolContract): boolean {
  const annotation = tool.annotations[DURABLE_TOOL_FACADE_ANNOTATION];
  return Boolean(annotation && typeof annotation === "object");
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
      yield* installJournalProgramRuntime();
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
    // SAFETY: registry lookup erases program type witnesses; the exact pinned
    // manifest schemas restore input/output types at attachment boundaries.
    const tools = createDurableToolRegistry([options.tool as unknown as DurableTool]);
    const drivers = createProgramDriverRegistry([
      ["program", createLocalDurableProgramDriver(tools)],
    ]);
    const effects = createDurableEffectRegistry(
      effectRegistrations(options.tool.manifest, outerContext, options.effectHandlers),
    );
    const activated = yield* withAuthority(function* (authority) {
      if (!snapshot) {
        yield* authority.command({
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
      }
      const outcome = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* DurableEffectRegistryContext.with(effects, function* () {
          return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
        });
      });
      const snapshotPort = yield* AuthoritySnapshotPort.use();
      const journalPort = yield* AuthorityJournalPort.use();
      return {
        outcome,
        snapshot: yield* snapshotPort.exportSnapshot(),
        journal: [...(yield* journalPort.readSession(invocationId))],
      };
    });
    const outcome = activated.outcome;
    activation += 1;
    snapshot = activated.snapshot;
    yield* options.stateStore.save(invocationId, snapshot);
    if (options.onActivation) {
      yield* options.onActivation({
        invocationId,
        activation,
        outcome,
        journal: activated.journal,
      });
    }

    if (outcome.state === "completed") {
      return assertReplayedCanonicalValue<O>(outcome.value);
    }
    if (outcome.state === "failed") {
      throw new DurableToolFacadeError("program_failed", outcome.error.message);
    }
    if (outcome.state === "cancelled") {
      throw new DurableToolFacadeError("program_cancelled", "Durable tool was cancelled");
    }

    const request = pendingElicit(activated.journal, outcome.pullId);
    if (!request) {
      throw new DurableToolFacadeError(
        "unsupported_park",
        `Unsupported durable facade park reason: ${outcome.reason}`,
      );
    }
    const response = yield* outerContext.elicit("foreign_input", {
      message: request.descriptor.message,
      context: {
        key: request.descriptor.key,
        responseSchema: request.descriptor.response.inputProjection,
        ...(request.descriptor.context !== undefined
          ? { context: request.descriptor.context }
          : {}),
      },
    });
    snapshot = yield* withAuthority(function* (authority) {
      const resolutionCapability = yield* authority.query({
        type: "pull.resolution-capability",
        sessionId: invocationId,
        taskId,
        pullId: request.pullId,
      });
      const resolution = yield* authority.command({
        type: "execution.resolve-pull",
        request: {
          capability: resolutionCapability,
          audience: `user:${request.descriptor.key}`,
          outcome: {
            status: "ok",
            value:
              response.action === "accept"
                ? { action: "accept", content: assertJson(response.content) }
                : {
                    action: response.action,
                    ...(response.reason !== undefined ? { reason: response.reason } : {}),
                  },
          },
        },
      });
      if (resolution.status === "rejected") {
        throw new DurableToolFacadeError(
          "resolution_rejected",
          `Unable to resolve durable facade elicitation: ${resolution.code}`,
        );
      }
      const snapshotPort = yield* AuthoritySnapshotPort.use();
      return yield* snapshotPort.exportSnapshot();
    });
    yield* options.stateStore.save(invocationId, snapshot);
  }
}

function effectRegistrations(
  manifest: DurableProgramManifest,
  outerContext: FacadeOuterContext,
  configured: ReadonlyMap<string, DurableEffectHandler> | undefined,
): DurableEffectRegistration[] {
  return Object.values(manifest.effects).map((definition) => ({
    definition,
    satisfies:
      definition.retrySafety.mode === "idempotent"
        ? { mode: "idempotent", mechanism: definition.retrySafety.mechanism }
        : definition.retrySafety.mode === "repeatable"
          ? { mode: "repeatable" }
          : { mode: "unsafe" },
    handler(input, context) {
      const configuredHandler = configured?.get(definition.name);
      if (configuredHandler) {
        return configuredHandler(input, context);
      }
      if (definition.name !== "model.sample") {
        return (function* () {
          throw new DurableToolFacadeError(
            "effect_handler_missing",
            `No facade effect handler for ${definition.name}`,
          );
        })();
      }
      return (function* () {
        return { status: "ok" as const, value: yield* bridgeModelSample(input, outerContext) };
      })();
    },
  }));
}

function* bridgeModelSample(input: Json, context: FacadeOuterContext): Operation<Json> {
  const prompt =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? input["prompt"]
      : undefined;
  const sample = yield* context.sample({
    prompt: typeof prompt === "string" ? prompt : JSON.stringify(input),
  });
  return {
    text: sample.text,
    ...(sample.model !== undefined ? { model: sample.model } : {}),
    ...(sample.stopReason !== undefined ? { stopReason: sample.stopReason } : {}),
  };
}

function assertManifestInput<I extends Json>(input: unknown): I {
  return assertReplayedCanonicalValue<I>(input);
}

function pendingElicit(records: DurableSemanticRecord[], pullId: string) {
  const record = records.find(
    (candidate) =>
      candidate.payload.type === "PullRequested" &&
      candidate.payload.pullId === pullId &&
      candidate.payload.descriptor.kind === "elicit",
  );
  if (!record || record.payload.type !== "PullRequested") {
    return undefined;
  }
  if (record.payload.descriptor.kind !== "elicit") {
    return undefined;
  }
  return {
    pullId: record.payload.pullId,
    descriptor: record.payload.descriptor,
  };
}
