import {
  CrankError,
  DurableProgramCancellation,
  PullApplicationError,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";

import { canonicalSnapshot } from "./canonical.ts";
import { foreignToolAdapterChild } from "@sweatpants/tool-session/foreign";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema-descriptor";
import { type Json, type SerializedApplicationError } from "./types.ts";
import type {
  DurableChildDescriptor,
  DurableProgramContext,
  DurableProgramFactory,
  DurableProgramManifest,
  DurableTaskHandle,
  DurableTool,
  ForeignToolRequest,
  EffectDefinition,
  OperationOutcome,
  ProgramResume,
  RecordAttemptContext,
  RecordOptions,
  RetrySafety,
  ProgramStepProposal,
  WireElicitResultJson,
} from "./durable-types.ts";

/** Default canonical payload limit enforced at journal boundaries. */
export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

/** Defines and freezes a schema-witnessed durable effect contract. */
export function defineDurableEffect<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
>(definition: EffectDefinition<I, O, P>): EffectDefinition<I, O, P> {
  validateEffectDefinition(definition);
  return deepFreeze(structuredClone(definition));
}

/** Parses and freezes a pinned durable program manifest. */
export function defineDurableProgramManifest<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
): DurableProgramManifest<I, O> {
  validateDurableManifest(manifest);
  return deepFreeze(structuredClone(manifest));
}

/** Creates an Effection-native crank program after validating its manifest and factory. */
export function createPinnedDurableProgram<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  validateDurableManifest(manifest);
  if (typeof program !== "function" || isAsyncFunction(program)) {
    throw new CrankError(
      "invalid_manifest",
      "Durable program must be an Effection Operation factory",
    );
  }
  const snapshot = deepFreeze(structuredClone(manifest));
  const tool: DurableTool<I, O> = {
    durability: "crank_native",
    manifest: snapshot,
    program,
    identityProvenance: Object.freeze({ kind: "asserted" }),
  };
  return Object.freeze(tool);
}

/** Rejects malformed manifests, schemas, retry policies, and noncanonical values. */
export function validateDurableManifest(manifest: DurableProgramManifest): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalidManifest("manifest");
  }
  requireId(manifest.programId, "programId");
  requireId(manifest.version, "version");
  if (typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest)) {
    invalidManifest("digest must be a lowercase SHA-256 hex value");
  }
  validateDescriptorField(manifest.inputSchema, "program_input", "inputSchema");
  validateDescriptorField(manifest.outputSchema, "program_output", "outputSchema");
  if (!isRecord(manifest.elicits)) {
    invalidManifest("elicits");
  }
  for (const [key, declaration] of Object.entries(manifest.elicits)) {
    requireId(key, "elicit key");
    if (!isRecord(declaration)) {
      invalidManifest(`elicits.${key}`);
    }
    validateDescriptorField(declaration.response, "elicit_response", `elicits.${key}.response`);
    if (declaration.context !== undefined) {
      validateDescriptorField(declaration.context, "elicit_context", `elicits.${key}.context`);
    }
  }
  if (!isRecord(manifest.effects)) {
    invalidManifest("effects");
  }
  for (const [key, definition] of Object.entries(manifest.effects)) {
    validateEffectDefinition(definition);
    if (definition.name !== key) {
      invalidManifest(`effect key ${key} must equal its symbolic name`);
    }
  }
  if (
    !manifest.capabilities ||
    manifest.capabilities.replay !== "strict" ||
    typeof manifest.capabilities.durableEmissions !== "boolean" ||
    typeof manifest.capabilities.structuredChildren !== "boolean"
  ) {
    invalidManifest("capabilities");
  }
  canonicalSnapshot(manifest);
}

/** Rejects malformed effect identity, schemas, or retry-safety policy. */
export function validateEffectDefinition(definition: EffectDefinition<Json, Json, Json>): void {
  if (!definition || typeof definition !== "object") {
    invalidManifest("effect definition");
  }
  requireId(definition.name, "effect name");
  requireId(definition.version, "effect version");
  validateDescriptorField(definition.inputSchema, "effect_input", `${definition.name}.inputSchema`);
  validateDescriptorField(
    definition.outputSchema,
    "effect_output",
    `${definition.name}.outputSchema`,
  );
  if (definition.cancellation !== undefined) {
    if (!isRecord(definition.cancellation)) {
      invalidManifest(`${definition.name}.cancellation`);
    }
    validateDescriptorField(
      definition.cancellation.partialSchema,
      "effect_cancellation_partial",
      `${definition.name}.cancellation.partialSchema`,
    );
  }
  const safety = definition.retrySafety;
  validateRetrySafety(safety, `${definition.name}.retrySafety`);
}

function validateRetrySafety(safety: RetrySafety, path: string): void {
  if (
    !safety ||
    (safety.mode === "repeatable" && Object.keys(safety).length !== 1) ||
    (safety.mode === "unsafe" && Object.keys(safety).length !== 1) ||
    (safety.mode === "idempotent" &&
      (Object.keys(safety).length !== 2 ||
        (safety.mechanism !== "pull_id_key" && safety.mechanism !== "inherent"))) ||
    (safety.mode !== "repeatable" && safety.mode !== "unsafe" && safety.mode !== "idempotent")
  ) {
    invalidManifest(path);
  }
}

type EffectResolver = { audience: string; route?: string };

/** Runtime bridge that suspends an Effection-native program at one durable proposal. */
export type DurableProposalExecutor = (proposal: ProgramStepProposal) => Operation<ProgramResume>;

/**
 * Creates the immutable authoring context over an explicit suspension bridge.
 * Production callers use a ProgramDriver; focused tests may provide a boundary
 * harness, but authored Operations are never manually iterated.
 */
export function createDurableProgramContext(
  executeProposal: DurableProposalExecutor,
): DurableProgramContext {
  let recording = false;
  const assertSchedulingAllowed = () => {
    if (recording) {
      throw new CrankError(
        "nested_durable_operation",
        "A recorded operation cannot schedule another durable operation",
      );
    }
  };
  const propose = function* (proposal: ProgramStepProposal): Operation<ProgramResume> {
    assertSchedulingAllowed();
    return yield* executeProposal(proposal);
  };
  const effect = function* (
    definitionOrName: EffectDefinition<Json, Json, Json> | string,
    versionOrInput: Json,
    inputOrResolver?: Json | EffectResolver,
    explicitResolver?: EffectResolver,
  ): Operation<Json> {
    const definition = typeof definitionOrName === "string" ? undefined : definitionOrName;
    if (definition) {
      validateEffectDefinition(definition);
    }
    const name = definition?.name ?? definitionOrName;
    const version = definition?.version ?? versionOrInput;
    const input = definition ? versionOrInput : inputOrResolver;
    const resolver = definition ? inputOrResolver : explicitResolver;
    if (typeof version !== "string" || input === undefined || !isEffectResolver(resolver)) {
      throw new CrankError("invalid_descriptor", "Invalid durable effect invocation");
    }
    const canonicalInput = canonicalSnapshot(input as Json).value;
    const outcome = yield* propose({
      type: "operation",
      descriptor: {
        kind: "effect",
        name: requireId(name, "effect name"),
        version: requireId(version, "effect version"),
        input: canonicalInput,
        resolver: {
          audience: requireId(resolver.audience, "resolver audience"),
          ...(resolver.route !== undefined
            ? { route: requireId(resolver.route, "resolver route") }
            : {}),
        },
      },
    });
    return unwrapOutcome(outcome);
  } as DurableProgramContext["effect"];
  const record = ((
    optionsOrOperation: string | RecordOptions | (() => Operation<Json>),
    explicitOperation?: (context: RecordAttemptContext) => Operation<Json>,
  ) => {
    assertSchedulingAllowed();
    const options =
      typeof optionsOrOperation === "function"
        ? {}
        : typeof optionsOrOperation === "string"
          ? { label: optionsOrOperation }
          : optionsOrOperation;
    if (
      typeof optionsOrOperation === "object" &&
      Object.keys(optionsOrOperation).some((key) => key !== "label" && key !== "retrySafety")
    ) {
      throw new CrankError("invalid_descriptor", "Recorded operation options are not closed");
    }
    const operation =
      typeof optionsOrOperation === "function" ? optionsOrOperation : explicitOperation;
    if (!operation) {
      throw new CrankError("invalid_descriptor", "Recorded operation is required");
    }
    const label = options.label;
    if (
      label !== undefined &&
      (typeof label !== "string" ||
        label.length === 0 ||
        new TextEncoder().encode(label).byteLength > 128)
    ) {
      throw new CrankError("invalid_descriptor", "Record label must be 1 to 128 UTF-8 bytes");
    }
    const retrySafety = options.retrySafety ?? { mode: "repeatable" as const };
    validateRetrySafety(retrySafety, "record.retrySafety");
    return (function* (): Operation<Json> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: {
          kind: "record",
          ...(label === undefined ? {} : { label }),
          retrySafety,
        },
        execute: function* (context: RecordAttemptContext) {
          recording = true;
          try {
            return yield* operation(context);
          } finally {
            recording = false;
          }
        },
      });
      return unwrapOutcome(outcome);
    })();
  }) as DurableProgramContext["record"];

  return Object.freeze({
    effect,
    record,
    *elicit<T extends Json = Json>(
      key: string,
      message: string,
      response: PortableSchemaDescriptor,
      context?: Json,
    ): Operation<WireElicitResultJson<T>> {
      const descriptor = parsePortableSchemaDescriptor(response);
      const outcome = yield* propose({
        type: "operation",
        descriptor: {
          kind: "elicit",
          key: requireId(key, "elicit key"),
          message: typeof message === "string" ? message : String(message),
          response: canonicalSnapshot(descriptor).value,
          ...(context !== undefined ? { context: canonicalSnapshot(context).value } : {}),
        },
      });
      return unwrapOutcome<WireElicitResultJson<T>>(outcome);
    },
    *emit(eventType: string, payload: Json): Operation<void> {
      yield* propose({
        type: "emission",
        descriptor: {
          eventType: requireId(eventType, "emission eventType"),
          payload: canonicalSnapshot(payload).value,
        },
      });
    },
    clock: Object.freeze({
      *waitUntil(instant: string, key = "waitUntil"): Operation<void> {
        const parsed = Date.parse(instant);
        if (!Number.isFinite(parsed)) {
          throw new CrankError("invalid_descriptor", "Invalid wait instant");
        }
        const outcome = yield* propose({
          type: "operation",
          descriptor: {
            kind: "wait",
            key: requireId(key, "wait key"),
            notBefore: new Date(parsed).toISOString(),
          },
        });
        unwrapOutcome(outcome);
      },
      *sleep(durationMs: number, key = "sleep"): Operation<void> {
        if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
          throw new CrankError(
            "invalid_descriptor",
            "durationMs must be a non-negative safe integer",
          );
        }
        const outcome = yield* propose({
          type: "operation",
          descriptor: { kind: "wait", key: requireId(key, "wait key"), durationMs },
        });
        unwrapOutcome(outcome);
      },
    }),
    *invoke<T extends Json = Json>(child: DurableChildDescriptor): Operation<T> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "invoke", child: snapshotChild(child) },
      });
      return unwrapOutcome<T>(outcome);
    },
    *all<T extends readonly Json[] = readonly Json[]>(
      children: DurableChildDescriptor[],
    ): Operation<T> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "all", children: children.map(snapshotChild) },
      });
      return unwrapOutcome<T>(outcome);
    },
    *race<T extends Json = Json>(children: DurableChildDescriptor[]): Operation<T> {
      if (children.length === 0) {
        throw new CrankError("invalid_descriptor", "race requires a child");
      }
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "race", children: children.map(snapshotChild) },
      });
      return unwrapOutcome<T>(outcome);
    },
    *spawn(child: DurableChildDescriptor): Operation<DurableTaskHandle> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "spawn", child: snapshotChild(child) },
      });
      return unwrapOutcome<DurableTaskHandle>(outcome);
    },
    *join<T extends Json = Json>(handle: DurableTaskHandle): Operation<T> {
      if (
        !isRecord(handle) ||
        typeof handle.__durableTask !== "string" ||
        typeof handle.owner !== "string"
      ) {
        throw new CrankError("invalid_descriptor", "Invalid durable task handle");
      }
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "join", handle: structuredClone(handle) },
      });
      return unwrapOutcome<T>(outcome);
    },
    *foreignTool<T extends Json = Json>(request: ForeignToolRequest): Operation<T> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "invoke", child: foreignToolAdapterChild(request) },
      });
      return unwrapOutcome<T>(outcome);
    },
  });
}

/**
 * Canonicalizes an already-accepted durable value without rerunning schema
 * code. Replay of recorded canonical values is structurally checked only;
 * Standard Schema validation happens exactly once at the authority acceptance
 * boundary through the digest-selected registry validator.
 */
export function assertReplayedCanonicalValue<T extends Json = Json>(
  value: unknown,
  errorCode = "invalid_descriptor",
): T {
  try {
    // SAFETY: canonicalSnapshot rejects every value that is not bounded
    // canonical JSON; the recorded value's type witness was fixed when the
    // authority accepted it.
    return canonicalSnapshot(value as T).value;
  } catch (error) {
    throw new CrankError(errorCode, "Recorded value is not canonical JSON", undefined, {
      cause: error,
    });
  }
}

/** Enforces a canonical UTF-8 payload limit before persistence or transport. */
export function assertInlineSize(value: Json, maxBytes = DEFAULT_MAX_INLINE_BYTES): void {
  const bytes = new TextEncoder().encode(canonicalSnapshot(value).canonical).byteLength;
  if (bytes > maxBytes) {
    throw new CrankError("payload_too_large", `Canonical payload is ${bytes} bytes`);
  }
}

function unwrapOutcome<T = Json>(input: unknown): T {
  if (!isOperationOutcome(input)) {
    throw new CrankError("invalid_descriptor", "Program resumed without a durable outcome");
  }
  // SAFETY: T is the author-declared result type; the authority validates the
  // recorded value against the exact pinned result schema before resumption.
  if (input.status === "ok") {
    return input.value as T;
  }
  if (input.status === "error") {
    throw new PullApplicationError(input.error);
  }
  throw new DurableProgramCancellation();
}

function isOperationOutcome(value: unknown): value is OperationOutcome {
  if (!isRecord(value) || typeof value["status"] !== "string") {
    return false;
  }
  if (value["status"] === "cancelled") {
    return !("partial" in value) || value["partial"] !== undefined;
  }
  if (value["status"] === "ok") {
    return "value" in value;
  }
  if (value["status"] !== "error") {
    return false;
  }
  const error = value["error"];
  return (
    isRecord(error) && typeof error["code"] === "string" && typeof error["message"] === "string"
  );
}

function snapshotChild(child: DurableChildDescriptor): DurableChildDescriptor {
  if (!child || typeof child !== "object") {
    throw new CrankError("invalid_descriptor", "Invalid child");
  }
  return {
    id: requireId(child.id, "child id"),
    version: requireId(child.version, "child version"),
    digest: requireDigest(child.digest, "child digest"),
    input: canonicalSnapshot(child.input).value,
  };
}

function validateDescriptorField(
  descriptor: PortableSchemaDescriptor,
  role: string,
  path: string,
): void {
  let parsed: PortableSchemaDescriptor;
  try {
    parsed = parsePortableSchemaDescriptor(descriptor);
  } catch (error) {
    throw new CrankError(
      "invalid_manifest",
      `Invalid durable manifest: ${path} is not a portable schema descriptor`,
      undefined,
      { cause: error },
    );
  }
  if (parsed.role !== role && parsed.role !== "builtin") {
    invalidManifest(`${path} descriptor role must be ${role}`);
  }
}

function isEffectResolver(value: unknown): value is EffectResolver {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!("audience" in value) || typeof value.audience !== "string") {
    return false;
  }
  return !("route" in value) || value.route === undefined || typeof value.route === "string";
}

function isRecord(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidManifest(`${field} must be non-empty`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalidManifest(`${field} must be SHA-256 hex`);
  }
  return value;
}

function invalidManifest(message: string): never {
  throw new CrankError("invalid_manifest", `Invalid durable manifest: ${message}`);
}

function isAsyncFunction(value: Function): boolean {
  return (
    value.constructor.name === "AsyncFunction" ||
    value.constructor.name === "AsyncGeneratorFunction"
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Projects thrown unknown values into a safe, serializable application error. */
export function serializeDurableError(error: unknown): SerializedApplicationError {
  if (error instanceof DurableProgramCancellation) {
    return { code: "program_cancelled", message: "Durable program cancelled" };
  }
  if (error instanceof PullApplicationError) {
    return error.applicationError;
  }
  if (error instanceof CrankError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  // Unknown thrown values may contain credentials, process handles, or transport
  // internals. They are intentionally not stringified into durable history.
  return { code: "program_error", message: "Durable program failed" };
}
