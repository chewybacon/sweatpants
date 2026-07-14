import type { Operation } from "effection";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/core";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  assertJson,
  assertSchemaValue,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  type CapabilityKeyring,
  type DurableAuthoritySnapshot,
  type DurableEffectHandler,
  type DurableEffectRegistration,
  type DurableProgramManifest,
  type DurableSemanticRecord,
  type DurableTool,
  type Json,
  type ProgramRunResult,
} from "@sweatpants/session-contract";

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
): RuntimeTool {
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
      const validatedInput = assertManifestInput<I>(options.tool.manifest.inputSchema, input);
      return yield* runFacadeProgram(options, invocationId, validatedInput, context);
    });
}

/** Returns whether a runtime tool carries the durable-facade annotation. */
export function isDurableToolSessionFacade(tool: RuntimeTool): boolean {
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

  while (true) {
    const authority = createInMemoryDurableJournalAuthority({
      journalId: `durable-tool-facade:${options.tool.manifest.programId}`,
      journalIncarnation: "1",
      keyring: options.keyring,
      ...(snapshot ? { snapshot } : {}),
    });
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
      route: { driverKind: "generator" },
      executionEpoch: 1,
    };
    if (!snapshot) {
      yield* authority.openTask({
        sessionId: invocationId,
        turnId: "turn-0",
        taskId,
        manifest: options.tool.manifest,
        input,
        executionEpoch: 1,
        attachmentId: "unattached-facade-program",
        audience: "program-runtime",
      });
    }

    // SAFETY: registry lookup erases program type witnesses; the exact pinned
    // manifest schemas restore input/output types at attachment boundaries.
    const tools = createDurableToolRegistry([options.tool as unknown as DurableTool]);
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalDurableProgramDriver(tools)],
    ]);
    const effects = createDurableEffectRegistry(
      effectRegistrations(options.tool.manifest, outerContext, options.effectHandlers),
    );
    const outcome = yield* ProgramDriverRegistryContext.with(drivers, function* () {
      return yield* JournalAuthorityContext.with(authority, function* () {
        return yield* DurableEffectRegistryContext.with(effects, function* () {
          return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
        });
      });
    });
    activation += 1;
    snapshot = authority.exportSnapshot();
    yield* options.stateStore.save(invocationId, snapshot);
    if (options.onActivation) {
      yield* options.onActivation({
        invocationId,
        activation,
        outcome,
        journal: authority.readJournal(invocationId),
      });
    }

    if (outcome.state === "completed") {
      return assertSchemaValue<O>(options.tool.manifest.outputSchema, outcome.value);
    }
    if (outcome.state === "failed") {
      throw new DurableToolFacadeError("program_failed", outcome.error.message);
    }
    if (outcome.state === "cancelled") {
      throw new DurableToolFacadeError("program_cancelled", "Durable tool was cancelled");
    }

    const request = pendingElicit(authority.readJournal(invocationId), outcome.pullId);
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
        responseSchema: request.descriptor.responseSchema,
        ...(request.descriptor.context !== undefined
          ? { context: request.descriptor.context }
          : {}),
      },
    });
    const resolution = yield* authority.resolve({
      capability: authority.resolutionCapability(invocationId, taskId, request.pullId),
      audience: `user:${request.descriptor.key}`,
      outcome:
        response.action === "accept"
          ? { status: "ok", value: assertJson(response.content) }
          : { status: "cancelled" },
    });
    if (resolution.status === "rejected") {
      throw new DurableToolFacadeError(
        "resolution_rejected",
        `Unable to resolve durable facade elicitation: ${resolution.code}`,
      );
    }
    snapshot = authority.exportSnapshot();
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

function assertManifestInput<I extends Json>(schema: Json, input: unknown): I {
  return assertSchemaValue<I>(schema, input);
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
