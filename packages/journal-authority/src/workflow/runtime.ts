import {
  Err,
  Ok,
  createContext,
  createQueue,
  resource,
  spawn,
  useAbortSignal,
  withResolvers,
  type Effect,
  type Operation,
  type Queue,
  type Result,
  type WithResolvers,
} from "effection";
import {
  ProgramPlacementContext,
  type OperationOutcome,
  type ProgramPlacementContextValue,
} from "@sweatpants/durable-effects";
import { z } from "zod";
import {
  createProgramExecutionValue,
  CrankError,
  DurableProgramCancellation,
  ProgramExecutionContext,
  PullApplicationError,
  assertInlineSize,
  assertReplayedCanonicalValue,
  serializeDurableError,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableElicitDescriptor,
  type DurableOperationDescriptor,
  type EmissionDescriptor,
  type EffectDescriptor,
  type WaitDescriptor,
  type DurableInvokeDescriptor,
  type ProgramShutdownReason,
  type RecordAttemptContext,
  type RecordedOperationDescriptor,
  type RecordOptions,
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";
import {
  parser,
  type Json,
  type Parser,
  type SerializedApplicationError,
  digestCanonicalJson,
  encodeCanonicalJson,
} from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import {
  pullKindPolicy,
  allDescriptorSchema,
  elicitDescriptorSchema,
  ephemeralDescriptorSchema,
  invokeDescriptorSchema,
  raceDescriptorSchema,
  sampleDescriptorSchema,
  waitDescriptorSchema,
} from "../pull-kinds/index.ts";
import { completedForkGroupTerminal, type ForkGroupTerminal } from "../forest/fork-group.ts";
import type { DurableChildDurability, DurableForkExpiry } from "@sweatpants/durable-execution";
import { definePort } from "@sweatpants/foundation/port";

import {
  ProgramEffectRuntimeContext,
  type ProgramEffectRuntime,
  type RuntimeRecordBoundary,
  type SerializableProgramProposal,
} from "./program-effect-runtime.ts";
export {
  ProgramEffectRuntimeContext,
  type ProgramEffectRuntime,
  type RuntimeRecordBoundary,
  type SerializableProgramProposal,
} from "./program-effect-runtime.ts";
import { executeNativeWork } from "./native-work.ts";
import type { NativeWorkComputation } from "./program-backend.ts";
import { driveProgramExecution, type ProgramExecutionState } from "./program-execution.ts";

/** An Effection Effect that can be yielded by a constrained Workflow. */
export type DurableProgramEffect<T> = Effect<T> & {
  readonly proposal: SerializableProgramProposal;
};

/** A generator whose yield channel accepts only durable boundaries. */
export type Workflow<T> = Generator<DurableProgramEffect<unknown>, T, unknown>;

/**
 * Authoring handle for one durable boundary: delegate with `yield*` to
 * suspend on it. The envelope exists so `yield*` infers the boundary's
 * settled type at the call site - `Workflow<T>` itself must keep a single
 * `unknown` next-slot, because ES generators cannot vary that type per
 * yield and a workflow mixes settlement shapes across its boundaries.
 */
export interface Durable<T> {
  [Symbol.iterator]: () => Iterator<DurableProgramEffect<unknown>, T, unknown>;
}

/**
 * Wraps one published effect. The single assertion here is the same
 * structural cast every authoring helper would otherwise repeat: the
 * workflow's next-slot is `unknown`, while the driver settles each effect
 * with exactly the value this envelope's type promises.
 */
function durable<T>(
  effect: DurableProgramEffect<unknown>,
  unwrap: (settled: OperationOutcome) => T,
): Durable<T> {
  return {
    *[Symbol.iterator]() {
      return unwrap((yield effect) as OperationOutcome);
    },
  };
}

const RecordAttemptGuardContext = createContext<boolean>("journal-authority:record-attempt", false);

const VOID_OK: Result<void> = Ok();

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown Workflow failure");
}

function effectFromOperation<T>(
  description: string,
  proposal: SerializableProgramProposal,
  operation: () => Operation<T>,
): DurableProgramEffect<T> {
  return {
    description,
    proposal,
    enter(resolve, routine) {
      const task = routine.scope.run(function* () {
        try {
          const value = yield* operation();
          resolve(Ok(value));
        } catch (error) {
          resolve(Err(error));
        }
      });
      return (finish) => {
        task.halt().then(
          () => finish(VOID_OK),
          (error) => finish(Err(error)),
        );
      };
    },
  };
}

const retrySafetySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("repeatable") }),
  z.strictObject({ mode: z.literal("unsafe") }),
  z.strictObject({
    mode: z.literal("idempotent"),
    mechanism: z.enum(["pull_id_key", "inherent"]),
  }),
]);

/** Wire shape of a portable schema reference inside descriptors. */
const portableSchemaDescriptorSchema = z.strictObject({
  identity: z.string().min(1),
  role: z.string().min(1).max(128),
  version: z.string().min(1),
  vendor: z.string().min(1),
  inputProjection: z.json(),
  outputProjection: z.json(),
  fidelity: z.strictObject({
    input: z.enum(["lossless", "explicit"]),
    output: z.enum(["lossless", "explicit"]),
  }),
  digest: z.string().min(1),
});

/** Single source of truth for record key rules across authoring and wire boundaries. */
const recordKeySchema = z
  .string()
  .min(1, "Record key must be non-empty")
  .refine((key) => new TextEncoder().encode(key).byteLength <= 128, {
    message: "Record key must be at most 128 UTF-8 bytes",
  });

const recordOptionsSchema = z.strictObject({
  key: recordKeySchema,
  retrySafety: retrySafetySchema.optional(),
});

/** Result-oriented parser for the record authoring boundary. */
export const recordWorkflowOptionsParser: Parser<RecordedOperationDescriptor> = parser(
  recordOptionsSchema,
).map((options) =>
  Object.freeze({
    kind: "record" as const,
    key: options.key,
    retrySafety: options.retrySafety ?? { mode: "repeatable" as const },
  }),
);

const effectOptionsSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  input: z.json(),
  resolver: z.strictObject({
    audience: z.string().min(1),
    route: z.string().optional(),
  }),
});

const elicitOptionsSchema = z.strictObject({
  key: recordKeySchema,
  message: z.string(),
  response: portableSchemaDescriptorSchema,
  contextContract: portableSchemaDescriptorSchema.optional(),
  context: z.json().optional(),
  binding: z.strictObject({ id: z.string().min(1) }).optional(),
});

/** Result-oriented parser for elicitation authoring. */
export const elicitOptionsParser: Parser<DurableElicitDescriptor> =
  parser(elicitOptionsSchema).map(normalizeElicitDescriptor);

/** Result-oriented parser for installed-effect authoring. */
export const effectOptionsParser: Parser<EffectDescriptor> = parser(effectOptionsSchema).map(
  (options) => Object.freeze(normalizeEffectDescriptor(options)),
);

const invokeOptionsSchema = z.strictObject({
  child: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().min(1),
    input: z.json(),
  }),
});

/** Result-oriented parser for child-program invocation authoring. */
export const invokeOptionsParser: Parser<DurableInvokeDescriptor> = parser(invokeOptionsSchema).map(
  (options) => ({
    kind: "invoke" as const,
    child: {
      id: options.child.id,
      version: options.child.version,
      digest: options.child.digest,
      input: options.child.input,
    },
  }),
);

const waitOptionsSchema = z.strictObject({
  key: recordKeySchema,
  notBefore: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
});

/** Result-oriented parser for wait authoring. */
export const waitOptionsParser: Parser<WaitDescriptor> = parser(waitOptionsSchema).map((options) =>
  Object.freeze(normalizeWaitDescriptor(options)),
);

function requireParsed<T>(
  valueParser: Parser<T>,
  value: unknown,
  code: string,
  fallback: string,
): T {
  const parsed = valueParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError(code, parsed.issues[0]?.message ?? fallback);
  }
  return parsed.value;
}

function unwrapOutcome<T extends Json>(outcome: OperationOutcome): T {
  if (outcome.status === "ok") {
    return outcome.value as T;
  }
  if (outcome.status === "cancelled") {
    throw new DurableProgramCancellation();
  }
  throw new PullApplicationError(outcome.error);
}

/**
 * Authoring handle for one authority-backed recorded operation.
 * Delegate with `yield*`; the settled value infers as `T`.
 */
export function record<T extends Json>(
  options: RecordOptions,
  execute: (attempt: RecordAttemptContext) => Operation<T>,
): Durable<T> {
  const descriptor = requireParsed(
    recordWorkflowOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid recorded operation options",
  );
  if (typeof execute !== "function") {
    throw new CrankError("invalid_descriptor", "Recorded operation is required");
  }
  const boundary: RuntimeRecordBoundary<T> = {
    serializable: { type: "operation", descriptor },
    execute,
  };
  return durable(
    effectFromOperation(`record(${descriptor.key})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "A recorded operation cannot schedule another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<T>(settled as OperationOutcome),
  );
}

/** Runs an ordinary Operation without publishing or consuming a durable boundary. */
export function ephemeral<T>(operation: Operation<T>): Durable<T> {
  return durable(
    effectFromOperation("ephemeral", { type: "ephemeral" }, function* () {
      const value = yield* operation;
      return value;
    }),
    (settled) => settled as T,
  );
}

/** Yields one manifest-declared installed effect executed by the authored body. */
export function effect<T extends Json>(
  options: {
    readonly name: string;
    readonly version: string;
    readonly input: Json;
    readonly resolver: { readonly audience: string; readonly route?: string };
  },
  execute: (attempt: RecordAttemptContext) => Operation<T>,
): Durable<T> {
  const descriptor = requireParsed(
    effectOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid effect options",
  );
  if (typeof execute !== "function") {
    throw new CrankError("invalid_descriptor", "Effect body is required");
  }
  const boundary: RuntimeRecordBoundary<T> = {
    serializable: { type: "operation", descriptor },
    execute,
  };
  return durable(
    effectFromOperation(`effect(${descriptor.name})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "An effect cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<T>(settled as OperationOutcome),
  );
}

/**
 * Yields one manifest-declared installed effect executed by the handler
 * registered on {@link InstalledEffectPort}. Use this form when the
 * implementation is host-configured rather than authored inline.
 */
export function installedEffect(options: {
  readonly name: string;
  readonly version: string;
  readonly input: Json;
  readonly resolver: { readonly audience: string; readonly route?: string };
}): Durable<Json> {
  const descriptor = requireParsed(
    effectOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid effect options",
  );
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: { type: "operation", descriptor },
    execute(attempt) {
      return (function* () {
        const handlers = yield* InstalledEffectPort.use();
        return yield* handlers.run(descriptor, attempt);
      })();
    },
  };
  return durable(
    effectFromOperation(`effect(${descriptor.name})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "An effect cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<Json>(settled as OperationOutcome),
  );
}

/** Yields one child-program invocation boundary settled by the composed child run. */
export function invoke(options: {
  readonly child: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly input: Json;
  };
}): Durable<Json> {
  const descriptor = requireParsed(
    invokeOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid invoke options",
  );
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: { type: "operation", descriptor },
    execute() {
      throw protocol("Invocations settle through child composition, not attempts");
    },
  };
  return durable(
    effectFromOperation(`invoke(${descriptor.child.id})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "An invocation cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<Json>(settled as OperationOutcome),
  );
}

/** Options for the fork combinators: exact pinned children plus an explicit
 *  or inherited expiry policy (REQ-030). */
export interface ForkOptions {
  readonly children: readonly {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly input: Json;
    /** Closed durability class (REQ-035); absent means crank_native. */
    readonly durability?: DurableChildDurability;
  }[];
  readonly expiry: DurableForkExpiry;
}

/**
 * The single fork composition boundary (REQ-022): one descriptor, one pull,
 * one Terminal value back (REQ-026). The supervision pairing is fixed by the
 * mode, so contradictory policies are unrepresentable (REQ-025).
 */
function forkPull<T extends Json>(
  mode: "all" | "race",
  options: ForkOptions,
  project: (terminal: Extract<ForkGroupTerminal, { status: "completed" }>) => T,
): Durable<T> {
  const input = {
    kind: mode,
    supervision: mode === "all" ? "one_for_all" : "first_success",
    children: options.children,
    expiry: options.expiry,
  } as const;
  const descriptor =
    mode === "all"
      ? requireParsed(
          parser(allDescriptorSchema),
          input,
          "invalid_descriptor",
          "Invalid all options",
        )
      : requireParsed(
          parser(raceDescriptorSchema),
          input,
          "invalid_descriptor",
          "Invalid race options",
        );
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: {
      type: "operation",
      descriptor: descriptor as unknown as DurableOperationDescriptor,
    },
    execute() {
      throw protocol("Fork groups settle through child composition, not attempts");
    },
  };
  return durable(
    effectFromOperation(
      `${mode}(${descriptor.children.length})`,
      boundary.serializable,
      function* () {
        const insideAttempt = yield* RecordAttemptGuardContext.get();
        if (insideAttempt) {
          throw new CrankError(
            "nested_durable_operation",
            "A fork group cannot be scheduled inside another durable operation",
          );
        }
        const runtime = yield* ProgramEffectRuntimeContext.expect();
        return yield* runtime.perform(boundary);
      },
    ),
    (settled) => {
      // failed/expired/orphaned surface as PullApplicationError via
      // unwrapOutcome; cancelled throws the program cancellation signal.
      const terminal = completedForkGroupTerminal(unwrapOutcome<Json>(settled));
      return project(terminal);
    },
  );
}

/**
 * Runs every child and gathers successful outcomes in descriptor member order
 * (REQ-026): the first failure starts one-for-all cancellation and the pull
 * resolves only after every member is terminal.
 */
export function all<T extends Json = Json>(options: ForkOptions): Durable<T[]> {
  return forkPull("all", options, (terminal) =>
    terminal.outcomes.map((entry) => {
      if (entry.outcome.status !== "ok") {
        throw protocol("A completed all group holds a non-ok biography");
      }
      return entry.outcome.value as T;
    }),
  );
}

/**
 * Races every child: the first successfully committed member wins, losers are
 * cancelled, and the winner resolves only after every loser is terminal.
 */
export function race<T extends Json = Json>(options: ForkOptions): Durable<T> {
  return forkPull("race", options, (terminal) => {
    const winner = terminal.outcomes.find((entry) => entry.ordinal === terminal.winnerOrdinal);
    if (!winner || winner.outcome.status !== "ok") {
      throw protocol("A completed race group holds no ok winner");
    }
    return winner.outcome.value as T;
  });
}

/**
 * Model-sampling pull. Journals the canonical wire request verbatim and parks
 * until the owning session resolves it — sampling never executes inline.
 */
export function modelSample<T extends Json = Json>(input: Json): Durable<T> {
  return pullOperation<T>({ kind: "sample", input });
}

/** Participant-settled elicitation boundary declared in the manifest. */
export function elicit(options: {
  readonly key: string;
  readonly message: string;
  readonly response: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly context?: Json;
  readonly binding?: { readonly id: string };
}): Durable<Json> {
  const descriptor = requireParsed(
    elicitOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid elicitation options",
  );
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: { type: "operation", descriptor },
    execute() {
      throw protocol("Elicitations settle through participant resolution, not attempts");
    },
  };
  return durable(
    effectFromOperation(`elicit(${descriptor.key})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "An elicitation cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<Json>(settled as OperationOutcome),
  );
}

/** Yields one authority-clock-settled wait boundary. */
export function wait(options: {
  readonly key: string;
  readonly notBefore?: string;
  readonly durationMs?: number;
}): Durable<Json> {
  const descriptor = requireParsed(
    waitOptionsParser,
    options,
    "invalid_descriptor",
    "Invalid wait options",
  );
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: { type: "operation", descriptor },
    execute() {
      throw protocol("Wait boundaries settle through resolution, not attempts");
    },
  };
  return durable(
    effectFromOperation(`wait(${descriptor.key})`, boundary.serializable, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "A wait cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.perform(boundary);
    }),
    (settled) => unwrapOutcome<Json>(settled as OperationOutcome),
  );
}

/** Appends one authority-visible emission and resolves to its journal offset. */
export function emit(eventType: string, payload: Json): Durable<Json> {
  if (typeof eventType !== "string" || eventType.length === 0) {
    throw new CrankError("invalid_descriptor", "Emission event type is required");
  }
  const descriptor: EmissionDescriptor = { eventType, payload };
  return durable(
    effectFromOperation(`emit(${eventType})`, { type: "emission", descriptor }, function* () {
      const insideAttempt = yield* RecordAttemptGuardContext.get();
      if (insideAttempt) {
        throw new CrankError(
          "nested_durable_operation",
          "An emission cannot be scheduled inside another durable operation",
        );
      }
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      return yield* runtime.requestEmission(descriptor);
    }),
    (settled) => settled as Json,
  );
}

export type ProgramCommand =
  | { readonly type: "start"; readonly input: Json }
  | { readonly type: "ack-emission"; readonly actionIndex: number; readonly offset: string }
  | {
      readonly type: "authorize-record";
      readonly actionIndex: number;
      readonly pullId: string;
      readonly attemptId: string;
      readonly descriptor: DurableOperationDescriptor;
      readonly placement?: ProgramPlacementContextValue;
    }
  | {
      readonly type: "resume-record";
      readonly actionIndex: number;
      readonly outcome: OperationOutcome;
      readonly receipt: ResolutionReceipt;
      readonly replayed: boolean;
    }
  | { readonly type: "cancel"; readonly reason?: string };

const recordedOperationDescriptorSchema = z.strictObject({
  kind: z.literal("record"),
  key: recordKeySchema,
  retrySafety: retrySafetySchema,
});

const effectDescriptorSchema = z.strictObject({
  kind: z.literal("effect"),
  name: z.string().min(1),
  version: z.string().min(1),
  input: z.json(),
  resolver: z.strictObject({
    audience: z.string().min(1),
    route: z.string().optional(),
  }),
});

/**
 * Sequential pull kinds accepted at the attachment boundary. Kind schemas are
 * owned by their pull-kind modules; parallel combinators (`all`, `race`,
 * `spawn`, `join`) are deliberately absent: the discriminated union rejects
 * them like any malformed command, so a crafted combinator descriptor can
 * never reserve, execute, or settle (TC-110).
 */
const sequentialOperationDescriptorSchema = z.discriminatedUnion("kind", [
  recordedOperationDescriptorSchema,
  effectDescriptorSchema,
  elicitDescriptorSchema,
  waitDescriptorSchema,
  invokeDescriptorSchema,
  sampleDescriptorSchema,
  ephemeralDescriptorSchema,
]);

/**
 * Descriptors a program may PROPOSE through the pull boundary: every
 * sequential kind plus the two fork combinators (REQ-022). Attempt
 * authorization keeps the sequential schema — fork descriptors never
 * execute inside attempts, they park and compose (TC-110's gate stands).
 */
const proposableOperationDescriptorSchema = z.discriminatedUnion("kind", [
  recordedOperationDescriptorSchema,
  effectDescriptorSchema,
  elicitDescriptorSchema,
  waitDescriptorSchema,
  invokeDescriptorSchema,
  sampleDescriptorSchema,
  ephemeralDescriptorSchema,
  allDescriptorSchema,
  raceDescriptorSchema,
]);

export { elicitDescriptorSchema, waitDescriptorSchema } from "../pull-kinds/index.ts";
export { assertEphemeralDescriptor } from "../pull-kinds/index.ts";

const pullDescriptorParser = parser(proposableOperationDescriptorSchema);

/**
 * One generic parked-pull boundary: parses any registered interaction
 * descriptor, journals it verbatim, and parks until session resolution.
 * Per-kind authoring helpers delegate here; labels come from kind policy.
 */
export function pullOperation<T extends Json = Json>(descriptor: unknown): Durable<T> {
  const parsed = requireParsed(
    pullDescriptorParser,
    descriptor,
    "invalid_descriptor",
    "Invalid pull descriptor",
  );
  const policy = pullKindPolicy(parsed.kind);
  if (!policy?.journalLabel) {
    throw new CrankError("invalid_descriptor", `Kind ${parsed.kind} does not accept pulls`);
  }
  const boundary: RuntimeRecordBoundary<Json> = {
    serializable: {
      type: "operation",
      descriptor: parsed as unknown as DurableOperationDescriptor,
    },
    execute() {
      throw protocol("Pulls settle through session resolution, not attempts");
    },
  };
  return durable(
    effectFromOperation(
      policy.journalLabel(parsed as unknown as Json),
      boundary.serializable,
      function* () {
        const insideAttempt = yield* RecordAttemptGuardContext.get();
        if (insideAttempt) {
          throw new CrankError(
            "nested_durable_operation",
            "A parked pull cannot be scheduled inside another durable operation",
          );
        }
        const runtime = yield* ProgramEffectRuntimeContext.expect();
        return yield* runtime.perform(boundary);
      },
    ),
    (settled) => unwrapOutcome<T>(settled as OperationOutcome),
  );
}
const serializedApplicationErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  details: z.json().optional(),
});
const operationOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.json() }),
  z.strictObject({ status: z.literal("error"), error: serializedApplicationErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), partial: z.json().optional() }),
]);
const resolutionReceiptSchema = z.strictObject({
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  pullId: z.string().min(1),
  resolutionOffset: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  outcomeDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  status: z.enum(["accepted", "duplicate"]),
});
const placementSchema = z.strictObject({
  journal: z.strictObject({ id: z.string().min(1), incarnation: z.string().min(1) }),
  program: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  route: z.json(),
  driverKind: z.string().min(1),
});

const programCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), input: z.json() }),
  z.strictObject({
    type: z.literal("authorize-record"),
    actionIndex: z.number().int().nonnegative(),
    pullId: z.string().min(1),
    attemptId: z.string().min(1),
    descriptor: sequentialOperationDescriptorSchema,
    placement: placementSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("resume-record"),
    actionIndex: z.number().int().nonnegative(),
    outcome: operationOutcomeSchema,
    receipt: resolutionReceiptSchema,
    replayed: z.boolean(),
  }),
  z.strictObject({ type: z.literal("cancel"), reason: z.string().optional() }),
  z.strictObject({
    type: z.literal("ack-emission"),
    actionIndex: z.number().int().nonnegative(),
    offset: z.string().min(1),
  }),
]);
const shutdownReasonSchema = z.enum([
  "parked",
  "completed",
  "failed",
  "cancelled",
  "transport_lost",
  "scope_exit",
]);

const programCommandStructureParser = parser(programCommandSchema);

function normalizeElicitDescriptor(options: z.output<typeof elicitOptionsSchema>) {
  return { kind: "elicit" as const, ...options };
}

function normalizeEffectDescriptor(options: z.output<typeof effectOptionsSchema>) {
  return { kind: "effect" as const, ...options };
}

function normalizeWaitDescriptor(options: z.output<typeof waitOptionsSchema>) {
  return { kind: "wait" as const, ...options };
}

function normalizeParsedDescriptor(
  descriptor: z.infer<typeof proposableOperationDescriptorSchema>,
): DurableOperationDescriptor {
  if (descriptor.kind !== "invoke") {
    return descriptor;
  }
  return {
    kind: "invoke",
    child: {
      id: descriptor.child.id,
      version: descriptor.child.version,
      digest: descriptor.child.digest,
      input: descriptor.child.input,
    },
  };
}

/** Result-oriented parser for host commands entering the attachment. */
export const programCommandParser: Parser<ProgramCommand> = programCommandStructureParser.map(
  (command): ProgramCommand => {
    switch (command.type) {
      case "start":
        return { type: "start", input: command.input };
      case "authorize-record":
        return {
          type: "authorize-record",
          actionIndex: command.actionIndex,
          pullId: command.pullId,
          attemptId: command.attemptId,
          descriptor: normalizeParsedDescriptor(command.descriptor),
        };
      case "resume-record":
        return {
          type: "resume-record",
          actionIndex: command.actionIndex,
          outcome: command.outcome,
          receipt: command.receipt,
          replayed: command.replayed,
        };
      case "cancel":
        return command;
      case "ack-emission":
        return {
          type: "ack-emission",
          actionIndex: command.actionIndex,
          offset: command.offset,
        };
    }
  },
);

/** Result-oriented parser for attachment teardown disposition. */
export const programShutdownReasonParser: Parser<ProgramShutdownReason> =
  parser(shutdownReasonSchema);

export type ProgramEvent =
  | {
      readonly type: "record-proposed";
      readonly actionIndex: number;
      readonly descriptor: DurableOperationDescriptor;
    }
  | {
      readonly type: "record-attempt-completed";
      readonly actionIndex: number;
      readonly attemptId: string;
      readonly outcome: OperationOutcome;
    }
  | { readonly type: "completed"; readonly actionIndex: number; readonly value: Json }
  | {
      readonly type: "failed";
      readonly actionIndex: number;
      readonly error: SerializedApplicationError;
    }
  | {
      readonly type: "emission-proposed";
      readonly actionIndex: number;
      readonly descriptor: EmissionDescriptor;
    }
  | {
      readonly type: "emission-recorded";
      readonly actionIndex: number;
      readonly offset: string;
    };

export interface ProgramAttachmentHandle {
  exchange(command: ProgramCommand): Operation<ProgramEvent>;
  setDisposition(reason: ProgramShutdownReason): void;
  /** Explicitly releases a driver-owned attachment before its caller scope ends. */
  close(reason: ProgramShutdownReason): Operation<void>;
}

/** Facts a live record attempt may read while coordinating its settlement. */
export interface CoordinatedRecordAttempt extends RecordAttemptContext {
  readonly actionIndex: number;
}

/**
 * One live record attempt boundary: perform fenced work, settle its claimed
 * outcome. Attachments install the ordinary-path driver at `min`; hosts
 * compose observation and fault-injection policy at `max`.
 */
export interface RecordAttemptContract {
  run(
    context: CoordinatedRecordAttempt,
    execute: () => Operation<Json>,
    settle: (value: Json) => OperationOutcome,
  ): Operation<OperationOutcome>;
}

function* failClosedRecordAttempt(): Operation<OperationOutcome> {
  throw protocol("no record attempt coordination installed");
}

/** Fail-closed attempt-coordination boundary following the authority port model. */
export const RecordAttemptPort = definePort<RecordAttemptContract>("record-attempt", {
  run: failClosedRecordAttempt,
});

/** Contract for hosts that execute installed (manifest-declared) effects. */
export interface InstalledEffectContract {
  /**
   * Executes one installed-effect attempt for the given descriptor.
   * Implementations MUST be deterministic per (descriptor, input) pair;
   * retry safety is enforced by the authority from the manifest.
   */
  run(descriptor: EffectDescriptor, attempt: RecordAttemptContext): Operation<Json>;
}

function* failClosedInstalledEffect(): Operation<Json> {
  throw protocol("no installed-effect handler registered");
}

/** Fail-closed installed-effect boundary; hosts compose handlers at this port. */
export const InstalledEffectPort = definePort<InstalledEffectContract>(
  "workflow-installed-effect",
  { run: failClosedInstalledEffect },
);

/** The ordinary live path: execute once, settle what execution produced. */
const ordinaryRecordAttemptDriver: RecordAttemptContract = {
  *run(_context, execute, settle) {
    const produced = yield* execute();
    return settle(produced);
  },
};

interface TrackedResolver<T> {
  readonly operation: Operation<T>;
  readonly settled: () => boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function trackedResolver<T>(
  description: string,
  registry: Set<TrackedResolver<unknown>>,
): TrackedResolver<T> {
  const gate = withResolvers<T>(description);
  let done = false;
  const tracked: TrackedResolver<T> = {
    operation: gate.operation,
    settled: () => done,
    resolve(value) {
      if (done) {
        return;
      }
      done = true;
      registry.delete(tracked as TrackedResolver<unknown>);
      gate.resolve(value);
    },
    reject(error) {
      if (done) {
        return;
      }
      done = true;
      registry.delete(tracked as TrackedResolver<unknown>);
      gate.reject(error);
    },
  };
  registry.add(tracked as TrackedResolver<unknown>);
  return tracked;
}

interface RuntimeBoundaryEvent {
  readonly type: "boundary";
  readonly actionIndex: number;
  readonly boundary: RuntimeRecordBoundary<Json>;
  readonly resume: TrackedResolver<OperationOutcome>;
}

interface RuntimeTerminalEvent {
  readonly type: "terminal";
  readonly event: Extract<ProgramEvent, { readonly type: "completed" | "failed" }>;
}

interface RuntimeEmissionEvent {
  readonly type: "emission";
  readonly actionIndex: number;
  readonly descriptor: EmissionDescriptor;
  readonly ack: TrackedResolver<Json>;
}

type RuntimeEvent = RuntimeBoundaryEvent | RuntimeEmissionEvent | RuntimeTerminalEvent;

interface CommandEnvelope {
  readonly command: ProgramCommand;
  readonly reply: TrackedResolver<ProgramEvent>;
}

type AttachmentPhase = "created" | "proposed" | "attempt-completed" | "terminal" | "disposed";

/**
 * What the attachment is currently waiting on. A pull boundary and an
 * emission acknowledgement are mutually exclusive, so one discriminated
 * field encodes the invariant that three loose fields could not.
 */
type AttachmentAwaiting =
  | {
      readonly kind: "pull";
      readonly boundary: RuntimeBoundaryEvent;
      readonly attempt?: {
        readonly pullId: string;
        readonly attemptId: string;
        readonly outcome: OperationOutcome;
      };
    }
  | {
      readonly kind: "emission";
      readonly descriptor: EmissionDescriptor;
      readonly ack: TrackedResolver<Json>;
    };

interface AttachmentState {
  readonly request: AttachProgramRequest;
  readonly commands: Queue<CommandEnvelope, void>;
  readonly events: Queue<RuntimeEvent, void>;
  readonly resolvers: Set<TrackedResolver<unknown>>;
  readonly dispose: WithResolvers<Error>;
  phase: AttachmentPhase;
  actionIndex: number;
  awaiting?: AttachmentAwaiting;
  activeExchange: boolean;
  disposition: ProgramShutdownReason;
}

function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}

function stale(): CrankError {
  return new CrankError("stale_program_capability", "Program attachment is disposed");
}

function sameCanonical<T>(left: T, right: T): boolean {
  return (
    encodeCanonicalJson(left as unknown as Json) === encodeCanonicalJson(right as unknown as Json)
  );
}

function verifyResumeReceipt(
  state: AttachmentState,
  command: Extract<ProgramCommand, { readonly type: "resume-record" }>,
): void {
  if (
    command.receipt.sessionId !== state.request.sessionId ||
    command.receipt.taskId !== state.request.taskId ||
    command.receipt.outcomeDigest !== digestCanonicalJson(command.outcome)
  ) {
    throw protocol("resume receipt mismatch");
  }
  const awaitingPull = state.awaiting?.kind === "pull" ? state.awaiting : undefined;
  if (awaitingPull?.attempt && command.receipt.pullId !== awaitingPull.attempt.pullId) {
    throw protocol("resume pull mismatch");
  }
}

function canonicalAttemptOutcome(value: Json): OperationOutcome {
  try {
    const canonical = assertReplayedCanonicalValue(value, "record_value_invalid");
    try {
      assertInlineSize(canonical);
    } catch (error) {
      throw new CrankError(
        "record_value_too_large",
        "Recorded value exceeds inline limit",
        undefined,
        {
          cause: error,
        },
      );
    }
    return { status: "ok", value: canonical };
  } catch (error) {
    return { status: "error", error: serializeDurableError(error) };
  }
}

function* runAttempt(
  state: AttachmentState,
  command: Extract<ProgramCommand, { readonly type: "authorize-record" }>,
): Operation<OperationOutcome> {
  const awaitingPull = state.awaiting;
  if (awaitingPull?.kind !== "pull") {
    throw protocol("attempt started without a pull boundary");
  }
  const pending = awaitingPull.boundary;
  const descriptor = pending.boundary.serializable.descriptor;
  if (typeof pending.boundary.execute !== "function") {
    // No authored executor exists for this boundary kind; fail the attempt
    // closed rather than executing or settling anything.
    return {
      status: "error",
      error: {
        code: "program_protocol_error",
        message: `No boundary adapter for kind ${descriptor.kind}`,
      },
    };
  }
  const cancellation = yield* useAbortSignal();
  try {
    const coordination = yield* RecordAttemptPort.use();
    const execute = function* () {
      return yield* coordination.run(
        {
          actionIndex: state.actionIndex,
          pullId: command.pullId,
          attemptId: command.attemptId,
          cancellation,
        },
        function* () {
          return yield* RecordAttemptGuardContext.with(true, function* () {
            return yield* pending.boundary.execute({
              pullId: command.pullId,
              attemptId: command.attemptId,
              cancellation,
            });
          });
        },
        canonicalAttemptOutcome,
      );
    };
    return command.placement
      ? yield* ProgramPlacementContext.with(command.placement, execute)
      : yield* execute();
  } catch (error) {
    return cancellation.aborted || error instanceof DurableProgramCancellation
      ? { status: "cancelled" }
      : { status: "error", error: serializeDurableError(error) };
  }
}

function nextRuntimeEvent(state: AttachmentState): Operation<RuntimeEvent> {
  return (function* () {
    const next = yield* state.events.next();
    if (next.done) {
      throw stale();
    }
    return next.value;
  })();
}

function presentRuntimeEvent(state: AttachmentState, runtimeEvent: RuntimeEvent): ProgramEvent {
  if (runtimeEvent.type === "terminal") {
    state.phase = "terminal";
    return runtimeEvent.event;
  }
  if (runtimeEvent.type === "emission") {
    if (state.awaiting) {
      throw protocol("runtime published two pending emissions");
    }
    state.awaiting = {
      kind: "emission",
      descriptor: runtimeEvent.descriptor,
      ack: runtimeEvent.ack,
    };
    return {
      type: "emission-proposed",
      actionIndex: runtimeEvent.actionIndex,
      descriptor: structuredClone(runtimeEvent.descriptor),
    };
  }
  if (runtimeEvent.actionIndex !== state.actionIndex) {
    throw protocol("runtime action mismatch");
  }
  if (state.awaiting) {
    throw protocol("runtime published two pending boundaries");
  }
  state.awaiting = { kind: "pull", boundary: runtimeEvent };
  state.phase = "proposed";
  return {
    type: "record-proposed",
    actionIndex: runtimeEvent.actionIndex,
    descriptor: structuredClone(runtimeEvent.boundary.serializable.descriptor),
  };
}

function* applyCommand(state: AttachmentState, command: ProgramCommand): Operation<ProgramEvent> {
  if (state.phase === "disposed") {
    throw stale();
  }
  if (command.type === "start") {
    if (state.phase !== "created") {
      throw protocol("start repeated or out of order");
    }
    if (!sameCanonical(command.input, state.request.input)) {
      throw protocol("start input mismatch");
    }
    const runtimeEvent = yield* nextRuntimeEvent(state);
    return presentRuntimeEvent(state, runtimeEvent);
  }
  if (command.type === "ack-emission") {
    const emission = state.awaiting?.kind === "emission" ? state.awaiting : undefined;
    if (!emission || command.actionIndex !== state.actionIndex) {
      throw protocol("emission ack mismatch");
    }
    const ack = emission.ack;
    delete state.awaiting;
    state.actionIndex += 1;
    ack.resolve(command.offset);
    const runtimeEvent = yield* nextRuntimeEvent(state);
    return presentRuntimeEvent(state, runtimeEvent);
  }
  const pullAwaiting = state.awaiting?.kind === "pull" ? state.awaiting : undefined;
  if (!pullAwaiting || (state.phase !== "proposed" && state.phase !== "attempt-completed")) {
    throw protocol("command before a pending record boundary");
  }
  if (command.type === "authorize-record") {
    if (state.phase !== "proposed") {
      throw protocol("authorization repeated or out of order");
    }
    if (
      command.actionIndex !== state.actionIndex ||
      !command.pullId ||
      !command.attemptId ||
      !sameCanonical(command.descriptor, pullAwaiting.boundary.boundary.serializable.descriptor)
    ) {
      throw protocol("authorization identity mismatch");
    }
    const attemptTask = yield* spawn(() => runAttempt(state, command));
    const outcome = yield* attemptTask;
    state.awaiting = {
      kind: "pull",
      boundary: pullAwaiting.boundary,
      attempt: {
        pullId: command.pullId,
        attemptId: command.attemptId,
        outcome,
      },
    };
    state.phase = "attempt-completed";
    return {
      type: "record-attempt-completed",
      actionIndex: state.actionIndex,
      attemptId: command.attemptId,
      outcome: structuredClone(outcome),
    };
  }
  if (command.type === "resume-record") {
    if (command.actionIndex !== state.actionIndex) {
      throw protocol("resume action mismatch");
    }
    if (state.phase === "proposed" && !command.replayed) {
      throw protocol("live resume has no completed attempt");
    }
    if (state.phase === "attempt-completed") {
      if (command.replayed) {
        throw protocol("live attempt marked as replay");
      }
      if (!pullAwaiting.attempt || !sameCanonical(command.outcome, pullAwaiting.attempt.outcome)) {
        throw protocol("resume outcome mismatch");
      }
    }
    verifyResumeReceipt(state, command);
    const boundary = pullAwaiting.boundary;
    delete state.awaiting;
    state.actionIndex += 1;
    boundary.resume.resolve(structuredClone(command.outcome));
    const runtimeEvent = yield* nextRuntimeEvent(state);
    return presentRuntimeEvent(state, runtimeEvent);
  }
  const pullAwaitingCancel = state.awaiting?.kind === "pull" ? state.awaiting : undefined;
  delete state.awaiting;
  pullAwaitingCancel?.boundary.resume.reject(new DurableProgramCancellation(command.reason));
  const runtimeEvent = yield* nextRuntimeEvent(state);
  return presentRuntimeEvent(state, runtimeEvent);
}

function rejectAll(state: AttachmentState, error: Error): void {
  for (const resolver of state.resolvers) {
    resolver.reject(error);
  }
}

function closeState(state: AttachmentState, error: Error): void {
  if (state.phase === "disposed") {
    return;
  }
  state.phase = "disposed";
  rejectAll(state, error);
  state.commands.close(undefined);
  state.events.close(undefined);
  state.dispose.resolve(error);
}

function* superviseCommands(state: AttachmentState): Operation<void> {
  while (state.phase !== "disposed" && state.phase !== "terminal") {
    const next = yield* state.commands.next();
    if (next.done) {
      return;
    }
    const envelope = next.value;
    try {
      const event = yield* applyCommand(state, envelope.command);
      envelope.reply.resolve(event);
    } catch (error) {
      const failure = asError(error);
      envelope.reply.reject(failure);
      closeState(state, failure);
      return;
    }
  }
}

/** Opens one resource-owned program attachment. */
export function openProgramAttachment(
  request: AttachProgramRequest,
  workflow:
    | (() => Operation<Json>)
    | NativeWorkComputation
    | { start(): Operation<ProgramExecutionState> },
  actionIndex = 0,
): Operation<ProgramAttachmentHandle> {
  return resource(function* (provide) {
    yield* RecordAttemptPort.installDriver(ordinaryRecordAttemptDriver);
    yield* ProgramExecutionContext.set(
      createProgramExecutionValue(request, stableProgramAttachmentId(request)),
    );
    const state: AttachmentState = {
      request: structuredClone(request),
      commands: createQueue<CommandEnvelope, void>(),
      events: createQueue<RuntimeEvent, void>(),
      resolvers: new Set(),
      dispose: withResolvers<Error>("dispose program attachment"),
      phase: "created",
      actionIndex,
      activeExchange: false,
      disposition: "scope_exit",
    };
    const runtime: ProgramEffectRuntime = {
      *perform<T extends Json>(boundary: RuntimeRecordBoundary<T>): Operation<OperationOutcome> {
        if (state.phase === "disposed") {
          throw stale();
        }
        const resume = trackedResolver<OperationOutcome>(
          `record resume ${state.actionIndex}`,
          state.resolvers,
        );
        state.events.add({
          type: "boundary",
          actionIndex: state.actionIndex,
          boundary,
          resume,
        });
        const outcome = yield* resume.operation;
        return outcome;
      },
      *requestEmission(descriptor: EmissionDescriptor): Operation<Json> {
        if (state.phase === "disposed") {
          throw stale();
        }
        const ack = trackedResolver<Json>(`emission ack ${state.actionIndex}`, state.resolvers);
        state.events.add({
          type: "emission",
          actionIndex: state.actionIndex,
          descriptor,
          ack,
        });
        return yield* ack.operation;
      },
    };

    yield* ProgramEffectRuntimeContext.set(runtime);
    const workflowTask = yield* spawn(function* () {
      try {
        const result =
          typeof workflow === "function" || "work" in workflow
            ? yield* executeNativeWork(
                typeof workflow === "function" ? workflow : workflow.work,
                runtime,
              )
            : yield* driveProgramExecution(() => workflow.start());
        const value = assertReplayedCanonicalValue(result, "schema_validation_failed");
        assertInlineSize(value);
        state.events.add({
          type: "terminal",
          event: { type: "completed", actionIndex: state.actionIndex, value },
        });
      } catch (error) {
        state.events.add({
          type: "terminal",
          event: {
            type: "failed",
            actionIndex: state.actionIndex,
            error: serializeDurableError(error),
          },
        });
      }
    });
    const supervisorTask = yield* spawn(() => superviseCommands(state));
    const disposerTask = yield* spawn(function* () {
      yield* state.dispose.operation;
      yield* supervisorTask.halt();
      yield* workflowTask.halt();
    });

    const handle: ProgramAttachmentHandle = Object.freeze({
      *exchange(command: ProgramCommand): Operation<ProgramEvent> {
        if (state.phase === "disposed" || state.phase === "terminal") {
          throw stale();
        }
        if (state.activeExchange) {
          const error = protocol("concurrent exchange");
          closeState(state, error);
          throw error;
        }
        state.activeExchange = true;
        const reply = trackedResolver<ProgramEvent>("attachment exchange", state.resolvers);
        try {
          const acceptedCommand = requireParsed(
            programCommandParser,
            command,
            "program_protocol_error",
            "Invalid program command",
          );
          state.commands.add({ command: acceptedCommand, reply });
          const event = yield* reply.operation;
          return event;
        } finally {
          state.activeExchange = false;
        }
      },
      setDisposition(reason: ProgramShutdownReason): void {
        const acceptedReason = requireParsed(
          programShutdownReasonParser,
          reason,
          "program_protocol_error",
          "Invalid shutdown disposition",
        );
        if (state.phase === "disposed") {
          throw stale();
        }
        state.disposition = acceptedReason;
      },
      *close(reason: ProgramShutdownReason): Operation<void> {
        if (state.phase === "disposed") {
          return;
        }
        state.disposition = requireParsed(
          programShutdownReasonParser,
          reason,
          "program_protocol_error",
          "Invalid shutdown disposition",
        );
        closeState(state, stale());
        yield* disposerTask;
      },
    });

    try {
      yield* provide(handle);
    } finally {
      closeState(state, stale());
      yield* supervisorTask.halt();
      yield* workflowTask.halt();
      yield* disposerTask.halt();
    }
  });
}

/** Drives the one-record workflow through the current scoped Journal Authority facade. */
