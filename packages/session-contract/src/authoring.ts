import { canonicalSnapshot } from "./canonical.ts";
import { foreignToolAdapterChild } from "./foreign-tool-contract.ts";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "./schema-descriptor.ts";
import {
  CrankError,
  PullApplicationError,
  type Json,
  type SerializedApplicationError,
} from "./types.ts";
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

/** Creates a synchronous crank-native tool after validating its manifest and factory. */
export function createDurableTool<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O>;
export function createDurableTool<I extends Json = Json, O extends Json = Json>(options: {
  manifest: DurableProgramManifest<I, O>;
  program: DurableProgramFactory<I, O>;
}): DurableTool<I, O>;
export function createDurableTool<I extends Json = Json, O extends Json = Json>(
  manifestOrOptions:
    | DurableProgramManifest<I, O>
    | { manifest: DurableProgramManifest<I, O>; program: DurableProgramFactory<I, O> },
  maybeProgram?: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  const manifest = "manifest" in manifestOrOptions ? manifestOrOptions.manifest : manifestOrOptions;
  const program = "manifest" in manifestOrOptions ? manifestOrOptions.program : maybeProgram;
  validateDurableManifest(manifest);
  if (typeof program !== "function" || isAsyncFunction(program)) {
    throw new CrankError(
      "invalid_manifest",
      "Durable program must be a synchronous generator factory",
    );
  }
  const snapshot = deepFreeze(structuredClone(manifest));
  const tool: DurableTool<I, O> = { durability: "crank_native", manifest: snapshot, program };
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
  if (
    !safety ||
    (safety.mode === "unsafe" &&
      safety.onIndeterminate !== "await_decision" &&
      safety.onIndeterminate !== "fail") ||
    (safety.mode === "idempotent" &&
      safety.mechanism !== "pull_id_key" &&
      safety.mechanism !== "inherent") ||
    (safety.mode !== "unsafe" && safety.mode !== "idempotent")
  ) {
    invalidManifest(`${definition.name}.retrySafety`);
  }
}

type EffectResolver = { audience: string; route?: string };

function durableEffect<I extends Json, O extends Json, P extends Json = never>(
  definition: EffectDefinition<I, O, P>,
  input: I,
  resolver: EffectResolver,
): Generator<ProgramStepProposal, O, ProgramResume>;
function durableEffect<T extends Json = Json>(
  name: string,
  version: string,
  input: Json,
  resolver: EffectResolver,
): Generator<ProgramStepProposal, T, ProgramResume>;
function* durableEffect(
  definitionOrName: EffectDefinition<Json, Json, Json> | string,
  versionOrInput: Json,
  inputOrResolver: Json | EffectResolver,
  explicitResolver?: EffectResolver,
): Generator<ProgramStepProposal, Json, ProgramResume> {
  const definition = typeof definitionOrName === "string" ? undefined : definitionOrName;
  if (definition) {
    validateEffectDefinition(definition);
  }
  const name = definition?.name ?? definitionOrName;
  const version = definition?.version ?? versionOrInput;
  const input = definition ? versionOrInput : inputOrResolver;
  const resolver = definition ? inputOrResolver : explicitResolver;
  if (typeof version !== "string" || !isEffectResolver(resolver)) {
    throw new CrankError("invalid_descriptor", "Invalid durable effect invocation");
  }
  // Effect input is validated processlessly by the journal authority through
  // the digest-selected Standard Schema validator at the reserve boundary.
  const outcome = yield {
    type: "operation",
    descriptor: {
      kind: "effect",
      name: requireId(name, "effect name"),
      version: requireId(version, "effect version"),
      input: canonicalSnapshot(input).value,
      resolver: {
        audience: requireId(resolver.audience, "resolver audience"),
        ...(resolver.route !== undefined
          ? { route: requireId(resolver.route, "resolver route") }
          : {}),
      },
    },
  };
  return unwrapOutcome(outcome);
}

/** Creates the immutable authoring context that yields only durable operation proposals. */
export function createDurableProgramContext(): DurableProgramContext {
  return Object.freeze({
    effect: durableEffect,
    *elicit<T extends Json = Json>(
      key: string,
      message: string,
      response: PortableSchemaDescriptor,
      context?: Json,
    ): Generator<ProgramStepProposal, WireElicitResultJson<T>, ProgramResume> {
      const descriptor = parsePortableSchemaDescriptor(response);
      const outcome = yield {
        type: "operation",
        descriptor: {
          kind: "elicit",
          key: requireId(key, "elicit key"),
          message: typeof message === "string" ? message : String(message),
          response: canonicalSnapshot(descriptor).value,
          ...(context !== undefined ? { context: canonicalSnapshot(context).value } : {}),
        },
      };
      return unwrapOutcome<WireElicitResultJson<T>>(outcome);
    },
    *emit(eventType: string, payload: Json): Generator<ProgramStepProposal, void, ProgramResume> {
      yield {
        type: "emission",
        descriptor: {
          eventType: requireId(eventType, "emission eventType"),
          payload: canonicalSnapshot(payload).value,
        },
      };
    },
    clock: Object.freeze({
      *waitUntil(
        instant: string,
        key = "waitUntil",
      ): Generator<ProgramStepProposal, void, ProgramResume> {
        const parsed = Date.parse(instant);
        if (!Number.isFinite(parsed)) {
          throw new CrankError("invalid_descriptor", "Invalid wait instant");
        }
        const outcome = yield {
          type: "operation",
          descriptor: {
            kind: "wait",
            key: requireId(key, "wait key"),
            notBefore: new Date(parsed).toISOString(),
          },
        };
        unwrapOutcome(outcome);
      },
      *sleep(
        durationMs: number,
        key = "sleep",
      ): Generator<ProgramStepProposal, void, ProgramResume> {
        if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
          throw new CrankError(
            "invalid_descriptor",
            "durationMs must be a non-negative safe integer",
          );
        }
        const outcome = yield {
          type: "operation",
          descriptor: { kind: "wait", key: requireId(key, "wait key"), durationMs },
        };
        unwrapOutcome(outcome);
      },
    }),
    *invoke<T extends Json = Json>(
      child: DurableChildDescriptor,
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "invoke", child: snapshotChild(child) },
      };
      return unwrapOutcome<T>(outcome);
    },
    *all<T extends readonly Json[] = readonly Json[]>(
      children: DurableChildDescriptor[],
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "all", children: children.map(snapshotChild) },
      };
      return unwrapOutcome<T>(outcome);
    },
    *race<T extends Json = Json>(
      children: DurableChildDescriptor[],
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      if (children.length === 0) {
        throw new CrankError("invalid_descriptor", "race requires a child");
      }
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "race", children: children.map(snapshotChild) },
      };
      return unwrapOutcome<T>(outcome);
    },
    *spawn(
      child: DurableChildDescriptor,
    ): Generator<ProgramStepProposal, DurableTaskHandle, ProgramResume> {
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "spawn", child: snapshotChild(child) },
      };
      return unwrapOutcome<DurableTaskHandle>(outcome);
    },
    *join<T extends Json = Json>(
      handle: DurableTaskHandle,
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      if (
        !isRecord(handle) ||
        typeof handle.__durableTask !== "string" ||
        typeof handle.owner !== "string"
      ) {
        throw new CrankError("invalid_descriptor", "Invalid durable task handle");
      }
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "join", handle: structuredClone(handle) },
      };
      return unwrapOutcome<T>(outcome);
    },
    *foreignTool<T extends Json = Json>(
      request: ForeignToolRequest,
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      const outcome = yield {
        type: "operation",
        descriptor: { kind: "invoke", child: foreignToolAdapterChild(request) },
      };
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

/** Structured cancellation signal raised inside a resumed durable generator. */
export class DurableProgramCancellation extends Error {
  readonly reason?: string;

  constructor(reason?: string) {
    super("Durable program cancelled");
    this.name = "DurableProgramCancellation";
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
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
  role: PortableSchemaRole,
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
