import type { Operation } from "effection";
import {
  canonicalSnapshot,
  type Json,
  type SerializedApplicationError,
} from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type { EffectDefinition, OperationOutcome, RetrySafety } from "@sweatpants/durable-effects";
import { CrankError, PullApplicationError } from "./errors.ts";
import type {
  DurableChildDescriptor,
  DurableTaskHandle,
  ForeignToolRequest,
  WireElicitResultJson,
} from "./program-contract.ts";
import type {
  DurableProgramContext,
  ProgramResume,
  ProgramStepProposal,
  RecordAttemptContext,
  RecordOptions,
} from "./program-authoring.ts";
import { assertEffectDefinition } from "@sweatpants/durable-effects/authoring";
import { DEFAULT_MAX_INLINE_BYTES } from "./program-authoring-runtime.ts";
import { z } from "zod";

type EffectResolver = { audience: string; route?: string };

const operationOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.json() }),
  z.strictObject({
    status: z.literal("error"),
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      details: z.json().optional(),
    }),
  }),
  z.strictObject({ status: z.literal("cancelled"), partial: z.json().optional() }),
]);
const durableChildSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  input: z.json(),
});
const effectResolverSchema = z.strictObject({
  audience: z.string(),
  route: z.string().optional(),
});
const durableTaskHandleSchema = z.strictObject({
  __durableTask: z.string().min(1),
  owner: z.string().min(1),
});

/** Runtime bridge that suspends an Effection-native program at one durable proposal. */
export type DurableProposalExecutor = (proposal: ProgramStepProposal) => Operation<ProgramResume>;

/**
 * Creates the immutable authoring context over an explicit suspension bridge.
 * Production callers use a ProgramDriver; focused tests may provide a boundary
 * harness, but authored Operations are never manually iterated.
 */
export interface DurableProgramContextOptions {
  readonly foreignToolChild?: (request: ForeignToolRequest) => DurableChildDescriptor;
}

export function createDurableProgramContext(
  executeProposal: DurableProposalExecutor,
  options: DurableProgramContextOptions = {},
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
      assertEffectDefinition(definition);
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
    options: RecordOptions,
    operation: (context: RecordAttemptContext) => Operation<Json>,
  ) => {
    assertSchedulingAllowed();
    if (
      !options ||
      typeof options !== "object" ||
      Object.keys(options).some((key) => key !== "key" && key !== "retrySafety")
    ) {
      throw new CrankError("invalid_descriptor", "Recorded operation options are not closed");
    }
    const key = requireId(options.key, "record key");
    if (new TextEncoder().encode(key).byteLength > 128) {
      throw new CrankError("invalid_descriptor", "Record key must be at most 128 UTF-8 bytes");
    }
    if (typeof operation !== "function") {
      throw new CrankError("invalid_descriptor", "Recorded operation is required");
    }
    const retrySafety = options.retrySafety ?? { mode: "repeatable" as const };
    assertRetrySafety(retrySafety, "record.retrySafety");
    return (function* (): Operation<Json> {
      const outcome = yield* propose({
        type: "operation",
        descriptor: { kind: "record", key, retrySafety },
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
      if (!durableTaskHandleSchema.safeParse(handle).success) {
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
        descriptor: {
          kind: "invoke",
          child: options.foreignToolChild
            ? options.foreignToolChild(request)
            : missingForeignToolChild(),
        },
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
  return operationOutcomeSchema.safeParse(value).success;
}

/** Structured cancellation signal raised inside a resumed durable program task. */
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

function missingForeignToolChild(): never {
  throw new CrankError("invalid_descriptor", "No foreign-tool adapter is installed");
}

function snapshotChild(child: DurableChildDescriptor): DurableChildDescriptor {
  const parsed = durableChildSchema.safeParse(child);
  if (!parsed.success) {
    throw new CrankError("invalid_descriptor", "Invalid child");
  }
  return { ...parsed.data, input: canonicalSnapshot(parsed.data.input).value };
}

function assertRetrySafety(safety: RetrySafety, path: string): void {
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

function isEffectResolver(value: unknown): value is EffectResolver {
  return effectResolverSchema.safeParse(value).success;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidManifest(`${field} must be non-empty`);
  }
  return value;
}

function invalidManifest(message: string): never {
  throw new CrankError("invalid_manifest", `Invalid durable manifest: ${message}`);
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
