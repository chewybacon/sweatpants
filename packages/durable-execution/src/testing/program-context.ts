import type { Operation } from "effection";
import { type Json, cloneJson } from "@sweatpants/foundation";
import type { EffectDefinition, OperationOutcome, RetrySafety } from "@sweatpants/durable-effects";
import { assertEffectDefinition } from "@sweatpants/durable-effects/authoring";
import { z } from "zod";

import { CrankError, PullApplicationError } from "../errors.ts";
import type { DurableOperationDescriptor, EmissionDescriptor } from "../program-contract.ts";
import type {
  DurableProgramContext,
  RecordAttemptContext,
  RecordOptions,
} from "../program-authoring.ts";
import { DurableProgramCancellation } from "../program-values.ts";

export type TestProgramResume = OperationOutcome | undefined;
export type TestProgramStepProposal =
  | {
      readonly type: "operation";
      readonly descriptor: DurableOperationDescriptor;
      readonly execute?: (context: RecordAttemptContext) => Operation<Json>;
    }
  | { readonly type: "emission"; readonly descriptor: EmissionDescriptor };
export type TestProposalExecutor = (
  proposal: TestProgramStepProposal,
) => Operation<TestProgramResume>;

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
const retrySafetySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("repeatable") }),
  z.strictObject({ mode: z.literal("unsafe") }),
  z.strictObject({
    mode: z.literal("idempotent"),
    mechanism: z.enum(["pull_id_key", "inherent"]),
  }),
]);
const effectResolverSchema = z.strictObject({
  audience: z.string(),
  route: z.string().optional(),
});

/** Focused proposal harness for authoring package tests; never used by production hosts. */
export function createTestDurableProgramContext(
  executeProposal: TestProposalExecutor,
): DurableProgramContext {
  let recording = false;
  const propose = function* (proposal: TestProgramStepProposal): Operation<TestProgramResume> {
    if (recording) {
      throw new CrankError(
        "nested_durable_operation",
        "A recorded operation cannot schedule another durable operation",
      );
    }
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
    const name = definition ? definition.name : (definitionOrName as string);
    const version = definition ? definition.version : versionOrInput;
    const input = definition ? versionOrInput : inputOrResolver;
    const resolver = definition ? inputOrResolver : explicitResolver;
    if (typeof version !== "string" || input === undefined || !isEffectResolver(resolver)) {
      throw new CrankError("invalid_descriptor", "Invalid durable effect invocation");
    }
    return unwrapOutcome(
      yield* propose({
        type: "operation",
        descriptor: {
          kind: "effect",
          name: requireId(name, "effect name"),
          version: requireId(version, "effect version"),
          input: cloneJson(input),
          resolver: {
            audience: requireId(resolver.audience, "resolver audience"),
            /* CONDITIONAL-SPREAD: Omit absent route from durable execution records; explicit undefined is not a portable JSON value. */
            ...(resolver.route === undefined
              ? {}
              : { route: requireId(resolver.route, "resolver route") }),
          },
        },
      }),
    );
  } as DurableProgramContext["effect"];
  const record = ((
    options: RecordOptions,
    operation: (context: RecordAttemptContext) => Operation<Json>,
  ) => {
    const key = requireId(options.key, "record key");
    if (new TextEncoder().encode(key).byteLength > 128) {
      throw new CrankError("invalid_descriptor", "Record key must be at most 128 UTF-8 bytes");
    }
    const retrySafety = options.retrySafety ?? { mode: "repeatable" as const };
    assertRetrySafety(retrySafety);
    return (function* (): Operation<Json> {
      return unwrapOutcome(
        yield* propose({
          type: "operation",
          descriptor: { kind: "record", key, retrySafety },
          *execute(context) {
            recording = true;
            try {
              return yield* operation(context);
            } finally {
              recording = false;
            }
          },
        }),
      );
    })();
  }) as DurableProgramContext["record"];

  return Object.freeze({
    *pull(descriptor: Json): Operation<Json> {
      const canonical = cloneJson(descriptor);
      if (
        canonical === null ||
        typeof canonical !== "object" ||
        Array.isArray(canonical) ||
        typeof canonical["kind"] !== "string"
      ) {
        throw new CrankError("invalid_descriptor", "Pull descriptor requires a kind");
      }
      return unwrapOutcome(
        yield* propose({
          type: "operation",
          descriptor: canonical as unknown as DurableOperationDescriptor,
        }),
      );
    },
    effect,
    record,
    *emit(eventType: string, payload: Json): Operation<void> {
      yield* propose({
        type: "emission",
        descriptor: {
          eventType: requireId(eventType, "emission eventType"),
          payload: cloneJson(payload),
        },
      });
    },
  });
}

function unwrapOutcome<T = Json>(input: unknown): T {
  if (!operationOutcomeSchema.safeParse(input).success) {
    throw new CrankError("invalid_descriptor", "Program resumed without a durable outcome");
  }
  const outcome = input as OperationOutcome;
  if (outcome.status === "ok") {
    return outcome.value as T;
  }
  if (outcome.status === "error") {
    throw new PullApplicationError(outcome.error);
  }
  throw new DurableProgramCancellation();
}

function assertRetrySafety(safety: RetrySafety): void {
  if (!retrySafetySchema.safeParse(safety).success) {
    throw new CrankError("invalid_manifest", "Invalid record retry safety");
  }
}

function isEffectResolver(value: unknown): value is EffectResolver {
  return effectResolverSchema.safeParse(value).success;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CrankError("invalid_manifest", `${field} must be non-empty`);
  }
  return value;
}
