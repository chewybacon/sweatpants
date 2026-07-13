import { assertJson, canonicalSnapshot } from "./canonical.ts";
import { foreignToolAdapterChild } from "./foreign-tool-contract.ts";
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
  JsonSchema,
  OperationOutcome,
  ProgramResume,
  ProgramStepProposal,
} from "./durable-types.ts";

export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

export function defineDurableEffect<I extends Json = Json, O extends Json = Json>(
  definition: EffectDefinition<I, O>,
): EffectDefinition<I, O> {
  validateEffectDefinition(definition);
  return deepFreeze(structuredClone(definition));
}

export function defineDurableProgramManifest<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
): DurableProgramManifest<I, O> {
  validateDurableManifest(manifest);
  return deepFreeze(structuredClone(manifest));
}

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

export function validateDurableManifest(manifest: DurableProgramManifest): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalidManifest("manifest");
  }
  requireId(manifest.programId, "programId");
  requireId(manifest.version, "version");
  if (typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest)) {
    invalidManifest("digest must be a lowercase SHA-256 hex value");
  }
  validateSchema(manifest.inputSchema, "inputSchema");
  validateSchema(manifest.outputSchema, "outputSchema");
  if (!isRecord(manifest.elicits)) {
    invalidManifest("elicits");
  }
  for (const [key, declaration] of Object.entries(manifest.elicits)) {
    requireId(key, "elicit key");
    if (!isRecord(declaration)) {
      invalidManifest(`elicits.${key}`);
    }
    validateSchema(declaration.responseSchema, `elicits.${key}.responseSchema`);
    if (declaration.contextSchema !== undefined) {
      validateSchema(declaration.contextSchema, `elicits.${key}.contextSchema`);
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

export function validateEffectDefinition(definition: EffectDefinition): void {
  if (!definition || typeof definition !== "object") {
    invalidManifest("effect definition");
  }
  requireId(definition.name, "effect name");
  requireId(definition.version, "effect version");
  validateSchema(definition.inputSchema, `${definition.name}.inputSchema`);
  validateSchema(definition.outputSchema, `${definition.name}.outputSchema`);
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

function durableEffect<I extends Json, O extends Json>(
  definition: EffectDefinition<I, O>,
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
  definitionOrName: EffectDefinition | string,
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
  if (definition) {
    assertSchemaValue(definition.inputSchema, input, "invalid_descriptor");
  }
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

export function createDurableProgramContext(): DurableProgramContext {
  return Object.freeze({
    effect: durableEffect,
    *elicit<T extends Json = Json>(
      key: string,
      message: string,
      responseSchema: JsonSchema,
      context?: Json,
    ): Generator<ProgramStepProposal, T, ProgramResume> {
      validateSchema(responseSchema, "elicit.responseSchema");
      const outcome = yield {
        type: "operation",
        descriptor: {
          kind: "elicit",
          key: requireId(key, "elicit key"),
          message: typeof message === "string" ? message : String(message),
          responseSchema: canonicalSnapshot(responseSchema).value,
          ...(context !== undefined ? { context: canonicalSnapshot(context).value } : {}),
        },
      };
      return unwrapOutcome<T>(outcome);
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

export function assertSchemaValue(
  schema: JsonSchema,
  value: unknown,
  errorCode = "schema_validation_failed",
): Json {
  const snapshot = canonicalSnapshot(assertJson(value));
  const error = schemaError(schema, snapshot.value, "$", new Set());
  if (error) {
    throw new CrankError(errorCode, error);
  }
  return snapshot.value;
}

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
  // T is the author-declared result type; runtime schema validation occurs at
  // the authority boundary before this recorded value reaches the program.
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
    return true;
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

export class DurableProgramCancellation extends Error {
  constructor() {
    super("Durable program cancelled");
    this.name = "DurableProgramCancellation";
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

function validateSchema(schema: JsonSchema, path: string): void {
  canonicalSnapshot(schema);
  if (typeof schema === "boolean") {
    return;
  }
  if (!isRecord(schema)) {
    invalidManifest(`${path} must be a JSON Schema object or boolean`);
  }
  if (schema["type"] !== undefined) {
    const type = schema["type"];
    const allowed = ["null", "boolean", "number", "integer", "string", "array", "object"];
    if (
      !(typeof type === "string" && allowed.includes(type)) &&
      !(
        Array.isArray(type) &&
        type.every((entry) => typeof entry === "string" && allowed.includes(entry))
      )
    ) {
      invalidManifest(`${path}.type`);
    }
  }
}

function schemaError(
  schema: JsonSchema,
  value: Json,
  path: string,
  seen: Set<JsonSchema>,
): string | undefined {
  if (schema === true) {
    return undefined;
  }
  if (schema === false) {
    return `${path} is rejected by schema`;
  }
  if (!isRecord(schema)) {
    return `${path} has an invalid schema`;
  }
  if (seen.has(schema)) {
    return `${path} has a recursive inline schema`;
  }
  seen.add(schema);
  try {
    if (
      "const" in schema &&
      canonicalSnapshot(schema["const"]).canonical !== canonicalSnapshot(value).canonical
    ) {
      return `${path} does not equal const`;
    }
    if (
      Array.isArray(schema["enum"]) &&
      !schema["enum"].some(
        (candidate) =>
          canonicalSnapshot(candidate).canonical === canonicalSnapshot(value).canonical,
      )
    ) {
      return `${path} is not in enum`;
    }
    if (Array.isArray(schema["allOf"])) {
      for (const candidate of schema["allOf"]) {
        const error = schemaError(candidate, value, path, seen);
        if (error) {
          return error;
        }
      }
    }
    if (
      Array.isArray(schema["anyOf"]) &&
      !schema["anyOf"].some((candidate) => !schemaError(candidate, value, path, new Set(seen)))
    ) {
      return `${path} does not match anyOf`;
    }
    if (
      Array.isArray(schema["oneOf"]) &&
      schema["oneOf"].filter((candidate) => !schemaError(candidate, value, path, new Set(seen)))
        .length !== 1
    ) {
      return `${path} does not match exactly one oneOf schema`;
    }
    const declared = schema["type"];
    const types =
      typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
    if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
      return `${path} has the wrong type`;
    }
    if (typeof value === "string") {
      if (typeof schema["minLength"] === "number" && [...value].length < schema["minLength"]) {
        return `${path} is too short`;
      }
      if (typeof schema["maxLength"] === "number" && [...value].length > schema["maxLength"]) {
        return `${path} is too long`;
      }
      if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value)) {
        return `${path} does not match pattern`;
      }
    }
    if (typeof value === "number") {
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
        return `${path} is below minimum`;
      }
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
        return `${path} exceeds maximum`;
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
        return `${path} has too few items`;
      }
      if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
        return `${path} has too many items`;
      }
      if (schema["items"] !== undefined) {
        for (const [index, item] of value.entries()) {
          const error = schemaError(schema["items"], item, `${path}[${index}]`, seen);
          if (error) {
            return error;
          }
        }
      }
    }
    if (isRecord(value)) {
      const required = Array.isArray(schema["required"]) ? schema["required"] : [];
      for (const key of required) {
        if (typeof key === "string" && !(key in value)) {
          return `${path}.${key} is required`;
        }
      }
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
      for (const [key, childSchema] of Object.entries(properties)) {
        const property = value[key];
        if (property !== undefined) {
          const error = schemaError(childSchema, property, `${path}.${key}`, seen);
          if (error) {
            return error;
          }
        }
      }
      if (schema["additionalProperties"] === false) {
        const extra = Object.keys(value).find((key) => !(key in properties));
        if (extra) {
          return `${path}.${extra} is not allowed`;
        }
      }
    }
    return undefined;
  } finally {
    seen.delete(schema);
  }
}

function matchesType(type: Json, value: Json): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
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

export function serializeDurableError(error: unknown): SerializedApplicationError {
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
  return { code: "program_error", message: error instanceof Error ? error.message : String(error) };
}
