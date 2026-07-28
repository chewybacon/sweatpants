import { CrankError } from "@sweatpants/durable-execution";
import { sleep, type Operation } from "effection";
import { createDurableEffectRegistration } from "@sweatpants/session-contract";
import {
  assertJson,
  canonicalJson,
  createPinnedDurableProgram,
  createPortableSchemaDescriptor,
  defineDurableEffect,
  sha256,
  type DurableEffectContext,
  type DurableEffectRegistration,
  type DurableSchemaRegistryEntry,
  type Json,
  type StandardSchemaV1,
} from "@sweatpants/session-contract";
import { ForeignA2ADurableSession } from "./foreign-session.ts";
import { foreignA2AMessageDigest } from "./foreign-validation.ts";
import type {
  ForeignA2AContinueRequest,
  ForeignA2AInterruption,
  ForeignA2AMessage,
  ForeignA2AObservationState,
  ForeignA2AOperatorDecision,
  ForeignA2ASessionEvent,
  ForeignA2AStartRequest,
  ForeignA2ATerminalResult,
} from "./foreign-task-types.ts";

export type ForeignA2AAdapterInput = {
  readonly request: ForeignA2AStartRequest;
};
export type ForeignA2AInterruptionDecision =
  | {
      readonly action: "respond";
      readonly message: ForeignA2AMessage;
      readonly messageIdempotencyExpiresAt?: string;
    }
  | { readonly action: "observe" }
  | { readonly action: "cancel" }
  | { readonly action: "abandon"; readonly reason: string };
type ForeignA2ATransition = {
  readonly state: ForeignA2AObservationState;
  readonly event: ForeignA2ASessionEvent;
};

function descriptor(
  identity: string,
  role: Parameters<typeof createPortableSchemaDescriptor>[0]["role"],
) {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1.0.0",
    vendor: "sweatpants-a2a",
    inputProjection: true,
    outputProjection: true,
    fidelity: { input: "explicit", output: "explicit" },
  });
}
function jsonSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants-a2a",
      validate(value: unknown) {
        try {
          return { value: assertJson(value) };
        } catch {
          return { issues: [{ message: "value must be canonical JSON" }] };
        }
      },
    },
  };
}

const INPUT = descriptor("sweatpants.foreign-a2a-adapter/input", "program_input");
const OUTPUT = descriptor("sweatpants.foreign-a2a-adapter/output", "program_output");
const START_INPUT = descriptor("sweatpants.foreign-a2a-adapter/start-input", "effect_input");
const TRANSITION_OUTPUT = descriptor(
  "sweatpants.foreign-a2a-adapter/transition-output",
  "effect_output",
);
const STATE_INPUT = descriptor("sweatpants.foreign-a2a-adapter/state-input", "effect_input");
const RESPOND_INPUT = descriptor("sweatpants.foreign-a2a-adapter/respond-input", "effect_input");
const DECISION_INPUT = descriptor("sweatpants.foreign-a2a-adapter/decision-input", "effect_input");
const DECISION_OUTPUT = descriptor(
  "sweatpants.foreign-a2a-adapter/decision-output",
  "effect_output",
);
const CANCEL_OUTPUT = descriptor("sweatpants.foreign-a2a-adapter/cancel-output", "effect_output");
const AMBIGUITY_INPUT = descriptor(
  "sweatpants.foreign-a2a-adapter/ambiguity-input",
  "effect_input",
);
const AMBIGUITY_OUTPUT = descriptor(
  "sweatpants.foreign-a2a-adapter/ambiguity-output",
  "effect_output",
);

export const FOREIGN_A2A_START_SURFACE_EFFECT = defineDurableEffect<
  ForeignA2AStartRequest,
  ForeignA2ATransition
>({
  name: "a2a.foreign.start.surface",
  version: "1.0.0",
  inputSchema: START_INPUT,
  outputSchema: TRANSITION_OUTPUT,
  retrySafety: { mode: "unsafe" },
});
export const FOREIGN_A2A_START_INTERVENE_EFFECT = defineDurableEffect<
  ForeignA2AStartRequest,
  ForeignA2ATransition
>({
  name: "a2a.foreign.start.intervene",
  version: "1.0.0",
  inputSchema: START_INPUT,
  outputSchema: TRANSITION_OUTPUT,
  // Intervention is a transition-layer decision made through
  // FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT. This effect stays distinct from its
  // `.surface` twin for audience and program branching, not retry policy.
  retrySafety: { mode: "unsafe" },
});
export const FOREIGN_A2A_OBSERVE_EFFECT = defineDurableEffect<
  ForeignA2AObservationState,
  ForeignA2ATransition
>({
  name: "a2a.foreign.observe",
  version: "1.0.0",
  inputSchema: STATE_INPUT,
  outputSchema: TRANSITION_OUTPUT,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});
export const FOREIGN_A2A_RESPOND_SURFACE_EFFECT = defineDurableEffect<
  { state: ForeignA2AObservationState; request: ForeignA2AContinueRequest },
  ForeignA2ATransition
>({
  name: "a2a.foreign.respond.surface",
  version: "1.0.0",
  inputSchema: RESPOND_INPUT,
  outputSchema: TRANSITION_OUTPUT,
  retrySafety: { mode: "unsafe" },
});
export const FOREIGN_A2A_RESPOND_INTERVENE_EFFECT = defineDurableEffect<
  { state: ForeignA2AObservationState; request: ForeignA2AContinueRequest },
  ForeignA2ATransition
>({
  name: "a2a.foreign.respond.intervene",
  version: "1.0.0",
  inputSchema: RESPOND_INPUT,
  outputSchema: TRANSITION_OUTPUT,
  // See `a2a.foreign.start.intervene`: intervention is a transition-layer
  // decision, and this handler's resolver cannot outlive the host.
  retrySafety: { mode: "unsafe" },
});
export const FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT = defineDurableEffect<
  ForeignA2AInterruption,
  ForeignA2AInterruptionDecision
>({
  name: "a2a.foreign.interruption.decision",
  version: "1.0.0",
  inputSchema: DECISION_INPUT,
  outputSchema: DECISION_OUTPUT,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});
export const FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT = defineDurableEffect<
  {
    state: ForeignA2AObservationState;
    result: Extract<ForeignA2ASessionEvent, { type: "indeterminate" }>["result"];
  },
  ForeignA2AOperatorDecision
>({
  name: "a2a.foreign.ambiguity.decision",
  version: "1.0.0",
  inputSchema: AMBIGUITY_INPUT,
  outputSchema: AMBIGUITY_OUTPUT,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});
export const FOREIGN_A2A_CANCEL_EFFECT = defineDurableEffect<ForeignA2AObservationState, Json>({
  name: "a2a.foreign.cancel",
  version: "1.0.0",
  inputSchema: STATE_INPUT,
  outputSchema: CANCEL_OUTPUT,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

export const FOREIGN_A2A_ADAPTER_PROGRAM = Object.freeze({
  id: "sweatpants.foreign-a2a-task-adapter",
  version: "1.0.0",
  digest: sha256(
    canonicalJson({
      domain: "sweatpants.foreign-a2a-task-adapter.artifact.v1",
      effects: [
        FOREIGN_A2A_START_SURFACE_EFFECT.name,
        FOREIGN_A2A_START_INTERVENE_EFFECT.name,
        FOREIGN_A2A_OBSERVE_EFFECT.name,
        FOREIGN_A2A_RESPOND_SURFACE_EFFECT.name,
        FOREIGN_A2A_RESPOND_INTERVENE_EFFECT.name,
        FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT.name,
        FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT.name,
        FOREIGN_A2A_CANCEL_EFFECT.name,
      ],
      input: INPUT.digest,
      output: OUTPUT.digest,
    }),
  ),
});

export const foreignA2ATaskAdapter = createPinnedDurableProgram(
  {
    programId: FOREIGN_A2A_ADAPTER_PROGRAM.id,
    version: FOREIGN_A2A_ADAPTER_PROGRAM.version,
    digest: FOREIGN_A2A_ADAPTER_PROGRAM.digest,
    inputSchema: INPUT,
    outputSchema: OUTPUT,
    elicits: {},
    effects: {
      [FOREIGN_A2A_START_SURFACE_EFFECT.name]: FOREIGN_A2A_START_SURFACE_EFFECT,
      [FOREIGN_A2A_START_INTERVENE_EFFECT.name]: FOREIGN_A2A_START_INTERVENE_EFFECT,
      [FOREIGN_A2A_OBSERVE_EFFECT.name]: FOREIGN_A2A_OBSERVE_EFFECT,
      [FOREIGN_A2A_RESPOND_SURFACE_EFFECT.name]: FOREIGN_A2A_RESPOND_SURFACE_EFFECT,
      [FOREIGN_A2A_RESPOND_INTERVENE_EFFECT.name]: FOREIGN_A2A_RESPOND_INTERVENE_EFFECT,
      [FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT.name]: FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT,
      [FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT.name]: FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT,
      [FOREIGN_A2A_CANCEL_EFFECT.name]: FOREIGN_A2A_CANCEL_EFFECT,
    },
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
  },
  function* (input: ForeignA2AAdapterInput, context) {
    const intervene = input.request.pin.ambiguityPolicy === "intervene";
    let cancellationState: ForeignA2AObservationState = {
      pin: input.request.pin,
      observationDigests: {},
      initialMessageDigest: foreignA2AMessageDigest(input.request.message),
      continuationIndex: 0,
    };
    let settled = false;
    const finish = (result: ForeignA2ATerminalResult): ForeignA2ATerminalResult => {
      settled = true;
      return result;
    };
    try {
      let transition = yield* context.effect(
        intervene ? FOREIGN_A2A_START_INTERVENE_EFFECT : FOREIGN_A2A_START_SURFACE_EFFECT,
        input.request,
        { audience: "foreign:a2a" },
      );
      while (true) {
        cancellationState = transition.state;
        const event = transition.event;
        if (event.type === "terminal") {
          return finish(event.result);
        }
        if (event.type === "indeterminate") {
          if (!intervene) {
            return finish(indeterminateResult(transition.state, event.result));
          }
          const decision = yield* context.effect(
            FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT,
            { state: transition.state, result: event.result },
            { audience: "operator:a2a-intervention" },
          );
          if (decision.action === "abandon") {
            return finish({
              status: "abandoned",
              guarantee: transition.state.pin.guarantee,
              ...(transition.state.binding?.taskId
                ? { taskId: transition.state.binding.taskId }
                : {}),
              ...(transition.state.binding?.contextId
                ? { contextId: transition.state.binding.contextId }
                : {}),
              reason: "Operator marked the foreign invocation abandoned",
            });
          }
          if (decision.action === "confirm_outcome" && decision.outcome) {
            return finish(decision.outcome);
          }
          if (decision.action === "bind_task" && decision.taskId) {
            transition = yield* context.effect(
              FOREIGN_A2A_OBSERVE_EFFECT,
              { ...transition.state, binding: { taskId: decision.taskId } },
              { audience: "foreign:a2a" },
            );
            continue;
          }
          if (decision.action === "retry_may_duplicate") {
            if (decision.acknowledgedDuplicateRisk !== true) {
              throw new CrankError(
                "a2a_duplicate_risk_not_acknowledged",
                "Operator retry requires duplicate-risk acknowledgment",
              );
            }
            transition = yield* context.effect(FOREIGN_A2A_START_INTERVENE_EFFECT, input.request, {
              audience: "foreign:a2a",
            });
            continue;
          }
          transition = transition.state.binding
            ? yield* context.effect(FOREIGN_A2A_OBSERVE_EFFECT, transition.state, {
                audience: "foreign:a2a",
              })
            : yield* context.effect(FOREIGN_A2A_START_INTERVENE_EFFECT, input.request, {
                audience: "foreign:a2a",
              });
          continue;
        }
        if (event.type === "progress") {
          yield* context.emit("a2a_task_progress", {
            invocationId: transition.state.pin.invocationId,
            taskId: event.task.id,
            state: event.task.status.state,
            digest: event.digest,
          });
          transition = yield* context.effect(FOREIGN_A2A_OBSERVE_EFFECT, transition.state, {
            audience: "foreign:a2a",
          });
          continue;
        }
        const decision = yield* context.effect(
          FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT,
          event.interruption,
          { audience: "caller:a2a-policy" },
        );
        if (decision.action === "abandon") {
          return finish({
            status: "abandoned",
            guarantee: transition.state.pin.guarantee,
            ...(transition.state.binding?.taskId
              ? { taskId: transition.state.binding.taskId }
              : {}),
            ...(transition.state.binding?.contextId
              ? { contextId: transition.state.binding.contextId }
              : {}),
            reason: decision.reason,
          });
        }
        if (decision.action === "cancel") {
          const cancellation = yield* context.effect(FOREIGN_A2A_CANCEL_EFFECT, transition.state, {
            audience: "foreign:a2a",
          });
          return finish(cancellationResult(transition.state, cancellation));
        }
        if (decision.action === "observe") {
          transition = yield* context.effect(FOREIGN_A2A_OBSERVE_EFFECT, transition.state, {
            audience: "foreign:a2a",
          });
          continue;
        }
        if (!transition.state.binding) {
          throw new CrankError("a2a_task_unbound", "Cannot answer an unbound interruption");
        }
        const request: ForeignA2AContinueRequest = {
          pin: transition.state.pin,
          taskId: transition.state.binding.taskId,
          ...(transition.state.binding.contextId
            ? { contextId: transition.state.binding.contextId }
            : {}),
          message: decision.message,
          ...(decision.messageIdempotencyExpiresAt
            ? { messageIdempotencyExpiresAt: decision.messageIdempotencyExpiresAt }
            : {}),
        };
        transition = yield* context.effect(
          intervene ? FOREIGN_A2A_RESPOND_INTERVENE_EFFECT : FOREIGN_A2A_RESPOND_SURFACE_EFFECT,
          { state: transition.state, request },
          { audience: "foreign:a2a" },
        );
      }
    } finally {
      if (!settled) {
        yield* context.effect(FOREIGN_A2A_CANCEL_EFFECT, cancellationState, {
          audience: "foreign:a2a",
        });
      }
    }
  },
);

export function foreignA2AAdapterChild(request: ForeignA2AStartRequest) {
  return { ...FOREIGN_A2A_ADAPTER_PROGRAM, input: { request } };
}

export function createForeignA2AEffectRegistrations(options: {
  readonly session: ForeignA2ADurableSession;
  readonly decide: (
    interruption: ForeignA2AInterruption,
    context: DurableEffectContext,
  ) => Operation<ForeignA2AInterruptionDecision>;
  readonly intervene?: (
    input: {
      state: ForeignA2AObservationState;
      result: Extract<ForeignA2ASessionEvent, { type: "indeterminate" }>["result"];
    },
    context: DurableEffectContext,
  ) => Operation<ForeignA2AOperatorDecision>;
  readonly pollIntervalMs?: number;
  /** Coalesces routine polling into one durable pull; defaults to one minute at 500ms. */
  readonly maxPollsPerObserveEffect?: number;
  readonly onProgress?: (
    event: Extract<ForeignA2ASessionEvent, { type: "progress" }>,
    state: ForeignA2AObservationState,
  ) => void;
}): DurableEffectRegistration[] {
  const schemas = { input: jsonSchema(), output: jsonSchema() };
  const start = (
    definition: typeof FOREIGN_A2A_START_SURFACE_EFFECT | typeof FOREIGN_A2A_START_INTERVENE_EFFECT,
  ) =>
    createDurableEffectRegistration(
      definition,
      { mode: "unsafe" },
      function* (request) {
        const transition = yield* options.session.start(request);
        return { status: "ok", value: transition };
      },
      schemas,
    );
  const respond = (
    definition:
      | typeof FOREIGN_A2A_RESPOND_SURFACE_EFFECT
      | typeof FOREIGN_A2A_RESPOND_INTERVENE_EFFECT,
  ) =>
    createDurableEffectRegistration(
      definition,
      { mode: "unsafe" },
      function* (input) {
        const transition = yield* options.session.respond(input.state, input.request);
        return { status: "ok", value: transition };
      },
      schemas,
    );
  return [
    start(FOREIGN_A2A_START_SURFACE_EFFECT),
    start(FOREIGN_A2A_START_INTERVENE_EFFECT),
    createDurableEffectRegistration(
      FOREIGN_A2A_OBSERVE_EFFECT,
      { mode: "idempotent", mechanism: "inherent" },
      function* (state) {
        const maxPolls = options.maxPollsPerObserveEffect ?? 120;
        if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) {
          throw new CrankError("invalid_descriptor", "A2A observe poll budget must be positive");
        }
        let current = state;
        let transition: ForeignA2ATransition | undefined;
        for (let poll = 0; poll < maxPolls; poll += 1) {
          yield* sleep(options.pollIntervalMs ?? 500);
          transition = yield* options.session.observe(current);
          current = transition.state;
          if (transition.event.type !== "progress") {
            break;
          }
          options.onProgress?.(transition.event, current);
        }
        if (!transition) {
          throw new CrankError("a2a_protocol_error", "A2A observer produced no transition");
        }
        return { status: "ok", value: transition };
      },
      schemas,
    ),
    respond(FOREIGN_A2A_RESPOND_SURFACE_EFFECT),
    respond(FOREIGN_A2A_RESPOND_INTERVENE_EFFECT),
    createDurableEffectRegistration(
      FOREIGN_A2A_INTERRUPTION_DECISION_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (interruption, context) {
        return { status: "ok", value: yield* options.decide(interruption, context) };
      },
      schemas,
    ),
    createDurableEffectRegistration(
      FOREIGN_A2A_AMBIGUITY_DECISION_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (input, context) {
        if (!options.intervene) {
          throw new CrankError(
            "a2a_intervention_unavailable",
            "No A2A operator intervention handler is installed",
          );
        }
        return { status: "ok", value: yield* options.intervene(input, context) };
      },
      schemas,
    ),
    createDurableEffectRegistration(
      FOREIGN_A2A_CANCEL_EFFECT,
      { mode: "idempotent", mechanism: "inherent" },
      function* (state) {
        const cancellation = yield* options.session.cancel(state);
        return { status: "ok", value: cancellation as unknown as Json };
      },
      schemas,
    ),
  ];
}

export const FOREIGN_A2A_SCHEMA_ENTRIES: readonly DurableSchemaRegistryEntry[] = Object.freeze(
  [
    INPUT,
    OUTPUT,
    START_INPUT,
    TRANSITION_OUTPUT,
    STATE_INPUT,
    RESPOND_INPUT,
    DECISION_INPUT,
    DECISION_OUTPUT,
    AMBIGUITY_INPUT,
    AMBIGUITY_OUTPUT,
    CANCEL_OUTPUT,
  ].map((portable) => ({ descriptor: portable, schema: jsonSchema() })),
);

function indeterminateResult(
  state: ForeignA2AObservationState,
  result: Extract<ForeignA2ASessionEvent, { type: "indeterminate" }>["result"],
): ForeignA2ATerminalResult {
  const { type: _type, ...details } = result;
  return { status: "indeterminate", guarantee: state.pin.guarantee, ...details };
}
function cancellationResult(
  state: ForeignA2AObservationState,
  value: Json,
): ForeignA2ATerminalResult {
  if (record(value) && value["status"] === "confirmed_canceled" && record(value["task"])) {
    const task = value["task"] as unknown as ForeignA2AObservationState["lastTask"];
    return {
      status: "canceled",
      guarantee: state.pin.guarantee,
      taskId: state.binding!.taskId,
      ...(state.binding?.contextId ? { contextId: state.binding.contextId } : {}),
      task: task!,
      artifacts: task!.artifacts,
    };
  }
  return {
    status: "indeterminate",
    guarantee: state.pin.guarantee,
    phase: "cancellation",
    invocationId: state.pin.invocationId,
    messageId: state.pin.initialMessageId,
    remoteTaskMayExist: true,
    ...(state.binding?.taskId ? { taskId: state.binding.taskId } : {}),
    ...(state.binding?.contextId ? { contextId: state.binding.contextId } : {}),
    code: "a2a_cancellation_indeterminate",
    message:
      record(value) && typeof value["status"] === "string"
        ? `Remote cancellation ended as ${value["status"]}`
        : "Remote cancellation became indeterminate",
  };
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
