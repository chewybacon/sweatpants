import type { Operation } from "effection";

import {
  CrankError,
  canonicalSnapshot,
  createLocalGeneratorDriver,
  type DurableToolRegistry,
  type Json,
  type ProgramAttachment,
  type ProgramStep,
  type ReplayEntry,
} from "@sweatpants/session-contract";
import {
  computeFrontierDigest,
  verifyReplayEntry,
  type HostProgramMessage,
  type RuntimeProgramMessage,
} from "./durable-protocol.ts";

export interface AgentCoreDurableEvaluatorOptions {
  readonly releaseId: string;
  readonly registry: DurableToolRegistry;
  readonly computeGeneration: string;
}

/** One connection-local pure evaluator. It owns no journal or effect credentials. */
export function createAgentCoreDurableEvaluator(options: AgentCoreDurableEvaluatorOptions): {
  handle(message: HostProgramMessage): Operation<RuntimeProgramMessage | undefined>;
} {
  const driver = createLocalGeneratorDriver(options.registry);
  let attachment: ProgramAttachment | undefined;
  let taskId: string | undefined;
  let activationEpoch: number | undefined;
  let input: Json | undefined;
  let step: ProgramStep | undefined;
  let replayChainSeed = "";
  let replayChainDigest = "";
  let replayedThrough = -1;
  let replayCount = 0;
  let terminal = false;

  return {
    *handle(message): Operation<RuntimeProgramMessage | undefined> {
      try {
        assertBase(message);
        if (message.type === "restore_begin") {
          if (attachment || terminal) throw protocol("restore_begin repeated");
          if (taskId && taskId !== message.taskId)
            throw new CrankError(
              "sandbox_task_mismatch",
              "Sandbox is invocation-affine to another task",
            );
          if (
            message.payload.attach.taskId !== message.taskId ||
            message.payload.attach.executionEpoch !== message.activationEpoch
          )
            throw protocol("Attach identity mismatch");
          if (
            canonicalSnapshot(message.payload.attach.input).sha !==
            message.payload.programInputDigest
          )
            throw protocol("Canonical input digest mismatch");
          taskId = message.taskId;
          activationEpoch = message.activationEpoch;
          input = message.payload.attach.input;
          replayChainSeed = message.payload.replayChainSeed;
          replayChainDigest = replayChainSeed;
          replayedThrough = message.payload.replayedThroughActionIndex;
          attachment = yield* driver.attach(message.payload.attach);
          return envelope(
            "restore_ready",
            {
              attachment: {
                attachmentId: attachment.attachmentId,
                taskId: attachment.taskId,
                driverKind: "agentcore",
                route: attachment.route,
                executionEpoch: attachment.executionEpoch,
              },
              computeGeneration: options.computeGeneration,
            },
            false,
          );
        }
        const current = requireAttachment(message);
        if (message.type === "replay_operation" || message.type === "replay_emission") {
          const entry = message.payload as ReplayEntry;
          if (!verifyReplayEntry(replayChainSeed, replayChainDigest, entry))
            throw new CrankError("replay_diverged", "Replay integrity chain mismatch");
          if (!step)
            step = yield* driver.step(current, { type: "start", input: requireInput(input) });
          compareReplayStep(step, entry);
          replayChainDigest = entry.entryDigest;
          replayCount += 1;
          step =
            entry.type === "operation"
              ? yield* driver.step(current, {
                  type: "resume",
                  actionIndex: entry.actionIndex,
                  outcome: entry.outcome,
                  receipt: entry.receipt,
                  replayed: true,
                })
              : yield* driver.step(current, {
                  type: "ack_emission",
                  actionIndex: entry.actionIndex,
                  offset: entry.offset,
                });
          return undefined;
        }
        if (message.type === "replay_end") {
          if (
            message.payload.entryCount !== replayCount ||
            message.payload.replayChainDigest !== replayChainDigest
          )
            throw new CrankError("history_not_exhausted", "Replay history end mismatch");
          if (!step)
            step = yield* driver.step(current, { type: "start", input: requireInput(input) });
          if (step.actionIndex <= replayedThrough) {
            throw new CrankError("history_not_exhausted", "Replay history was not exhausted");
          }
          const frontierDigest = computeFrontierDigest({
            releaseId: options.releaseId,
            taskId: taskId!,
            activationEpoch: activationEpoch!,
            replayedThroughActionIndex: replayedThrough,
            replayChainDigest,
            step,
          });
          return envelope(
            "frontier",
            {
              step,
              replayedThroughActionIndex: replayedThrough,
              replayChainDigest,
              frontierDigest,
            },
            true,
            step.actionIndex,
          );
        }
        if (message.type === "command") {
          step = yield* driver.step(current, message.payload.command);
          return envelope("step", { step }, true, step.actionIndex);
        }
        if (message.type === "shutdown") {
          yield* driver.shutdown(current, message.payload.reason);
          terminal = true;
          return envelope("shutdown_complete", {}, true);
        }
        throw protocol("Unexpected evaluator message");
      } catch (error) {
        const code = error instanceof CrankError ? error.code : "agentcore_runtime_rejected";
        return envelope(
          "rejected",
          {
            code: allowedCode(code),
            message: safeMessage(error),
          },
          Boolean(attachment),
        );
      }
    },
  };

  function assertBase(message: HostProgramMessage): void {
    if (message.releaseId !== options.releaseId)
      throw new CrankError("placement_unavailable", "Runtime release mismatch");
    if (taskId && message.taskId !== taskId)
      throw new CrankError("sandbox_task_mismatch", "Sandbox task mismatch");
    if (activationEpoch !== undefined && message.activationEpoch !== activationEpoch)
      throw new CrankError("stale_activation", "Activation epoch mismatch");
  }

  function requireAttachment(message: HostProgramMessage): ProgramAttachment {
    if (!attachment || message.attachmentId !== attachment.attachmentId)
      throw protocol("Attachment identity mismatch");
    if (terminal) throw protocol("Attachment is terminal");
    return attachment;
  }

  function envelope<T extends RuntimeProgramMessage["type"]>(
    type: T,
    payload: Extract<RuntimeProgramMessage, { type: T }>["payload"],
    includeAttachment: boolean,
    actionIndex?: number,
  ): Extract<RuntimeProgramMessage, { type: T }> {
    return {
      protocolVersion: 1,
      type,
      releaseId: options.releaseId,
      taskId: taskId ?? "unbound",
      activationEpoch: activationEpoch ?? 0,
      ...(includeAttachment && attachment ? { attachmentId: attachment.attachmentId } : {}),
      ...(actionIndex !== undefined ? { actionIndex } : {}),
      payload,
    } as Extract<RuntimeProgramMessage, { type: T }>;
  }
}

function requireInput(input: Json | undefined): Json {
  if (input === undefined) throw protocol("Restore input is missing");
  return input;
}

function compareReplayStep(step: ProgramStep, entry: ReplayEntry): void {
  if (step.actionIndex !== entry.actionIndex || step.type !== entry.type)
    throw new CrankError("replay_diverged", "Replay action or kind mismatch");
  if (step.type !== "operation" && step.type !== "emission")
    throw new CrankError("replay_diverged", "Program returned before replay history ended");
  const descriptorKind = step.type === "operation" ? step.descriptor.kind : "emission";
  if (
    descriptorKind !== entry.descriptorKind ||
    canonicalSnapshot(step.descriptor).sha !== entry.descriptorDigest
  )
    throw new CrankError("replay_diverged", "Replay descriptor mismatch");
}

function allowedCode(
  code: string,
): Extract<RuntimeProgramMessage, { type: "rejected" }>["payload"]["code"] {
  const allowed = new Set([
    "placement_unavailable",
    "program_version_unavailable",
    "schema_version_unavailable",
    "activation_busy",
    "stale_activation",
    "restore_stale",
    "replay_diverged",
    "history_not_exhausted",
    "protocol_version_unsupported",
    "program_protocol_error",
    "sandbox_task_mismatch",
    "payload_too_large",
    "agentcore_auth_failed",
    "agentcore_transport_lost",
    "agentcore_session_stopped",
    "agentcore_runtime_rejected",
  ]);
  return allowed.has(code)
    ? (code as ReturnType<typeof allowedCode>)
    : "agentcore_runtime_rejected";
}
function safeMessage(error: unknown): string {
  const message =
    error instanceof CrankError ? error.message : "AgentCore evaluator rejected the request";
  return message.replace(/arn:[^\s]+/g, "[redacted]").slice(0, 4096);
}
function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}
