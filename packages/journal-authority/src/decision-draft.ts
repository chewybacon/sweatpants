import {
  CrankError,
  DEFAULT_MAX_INLINE_BYTES,
} from "@sweatpants/durable-execution";
import { stableTupleHash, type Json } from "@sweatpants/foundation";

import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
} from "./authority-contract.ts";
import {
  signCapability,
  verifyProgramCapability,
} from "./capabilities.ts";
import {
  cloneAuthorityState,
  pullAudience,
  taskOriginSession,
  type DraftPull,
  type DraftSession,
  type DraftState,
  type DraftTask,
} from "./decision-state.ts";
import { parseRegisteredSchema } from "./schema-registry.ts";
import type { DurableSemanticRecord } from "./semantic-record.ts";
import { normalizeEmissionPolicy } from "./authority-support.ts";
import type { SemanticEmissionPolicy } from "./authority-snapshot.ts";

export interface AuthorityDecisionOptions {
  readonly maxOutcomeBytes?: number;
  readonly emissionPolicy?: SemanticEmissionPolicy;
}

/** Mutable transaction draft shared by focused decision modules. */
export class DecisionDraft {
  readonly state: DraftState;
  readonly entries: DurableSemanticRecord[] = [];
  readonly context: AuthorityDecisionFrame<AuthorityCommand>["context"];
  readonly maxOutcomeBytes: number;
  readonly emissionPolicy: SemanticEmissionPolicy | undefined;
  readonly offsets = new Map<string, number>();

  constructor(frame: AuthorityDecisionFrame<AuthorityCommand>, options: AuthorityDecisionOptions) {
    this.state = cloneAuthorityState(frame.state);
    this.context = frame.context;
    this.maxOutcomeBytes = options.maxOutcomeBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.emissionPolicy = options.emissionPolicy
      ? normalizeEmissionPolicy(options.emissionPolicy)
      : undefined;
    this.offsets.set(frame.context.appendCursor.sessionId, frame.context.appendCursor.nextOffset);
  }

  session(sessionId: string): DraftSession {
    let session = this.state.sessions.get(sessionId);
    if (session === undefined) {
      session = {
        execution: { tasks: new Map() },
        control: {
          runnable: false,
          revision: 0,
          lastActivationEpoch: 0,
          consecutiveRestoreStales: 0,
        },
      };
      this.state.sessions.set(sessionId, session);
    }
    return session;
  }

  task(sessionId: string, taskId: string): DraftTask {
    const task = this.state.sessions.get(sessionId)?.execution.tasks.get(taskId);
    if (task === undefined) throw new CrankError("unknown_target", `Unknown task ${taskId}`);
    return task;
  }

  append(
    sessionId: string,
    ownerEpoch: number | undefined,
    payload: DurableSemanticRecord["payload"],
  ): string {
    const next = this.offsets.get(sessionId) ?? 0;
    const offset = String(next);
    this.offsets.set(sessionId, next + 1);
    this.entries.push({
      offset,
      eventId: `journal:${sessionId}:${offset}`,
      sessionId,
      ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
      payload: structuredClone(payload),
    });
    this.session(sessionId).control.revision += 1;
    return offset;
  }

  nonce(): string {
    this.state.nextNonce += 1;
    return stableTupleHash(["nonce", this.context.journalIdentity.id, this.state.nextNonce]);
  }

  programCapability(task: DraftTask, deterministicNonce?: string): string {
    return signCapability(
      {
        journalId: this.context.journalIdentity.id,
        journalIncarnation: this.context.journalIdentity.incarnation,
        sessionId: taskOriginSession(this.state, task.taskId),
        taskId: task.taskId,
        programId: task.program.artifact.id,
        programVersion: task.program.artifact.version,
        programDigest: task.program.artifact.digest,
        attachmentId: task.execution.attachmentId,
        executionEpoch: task.execution.epoch,
        audience: task.execution.audience,
        permissions: ["propose", "complete"],
        nonce: deterministicNonce ?? this.nonce(),
      },
      this.context.keyring,
    );
  }

  resolutionCapability(task: DraftTask, pull: DraftPull, attemptId: string | undefined): string {
    return signCapability(
      {
        journalId: this.context.journalIdentity.id,
        journalIncarnation: this.context.journalIdentity.incarnation,
        sessionId: taskOriginSession(this.state, task.taskId),
        taskId: task.taskId,
        pullId: pull.pullId,
        descriptorDigest: pull.request.proposedDescriptorDigest,
        resultSchemaDigest: pull.request.resultSchemaDigest,
        attemptId: attemptId ?? "none",
        audience: pullAudience(pull),
        permissions: ["resolve"],
        maxOutcomeBytes: pull.request.maxOutcomeBytes,
        nonce: this.nonce(),
      },
      this.context.keyring,
    );
  }

  assertActive(task: DraftTask): void {
    if (task.lifecycle.status !== "active") throw new CrankError("task_terminal");
  }

  assertProgram(token: string, task: DraftTask, sessionId: string): void {
    const claims = verifyProgramCapability(token, this.context.keyring, {
      audience: task.execution.audience,
      journalId: this.context.journalIdentity.id,
      journalIncarnation: this.context.journalIdentity.incarnation,
      sessionId,
      taskId: task.taskId,
      executionEpoch: task.execution.epoch,
      attachmentId: task.execution.attachmentId,
    });
    if (
      claims.programId !== task.program.artifact.id ||
      claims.programVersion !== task.program.artifact.version ||
      claims.programDigest !== task.program.artifact.digest
    ) {
      throw new CrankError("program_version_mismatch");
    }
  }

  parseSchema(digest: string, value: unknown, errorCode: string): Json {
    const validated = parseRegisteredSchema(this.context.schemas, digest, value);
    if (validated.status === "unavailable") throw new CrankError("schema_version_unavailable");
    if (validated.status === "invalid" || validated.status === "schema-error") {
      throw new CrankError(errorCode);
    }
    return validated.value;
  }
}
