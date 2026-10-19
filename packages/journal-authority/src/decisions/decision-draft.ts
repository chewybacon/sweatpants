import { CrankError, DEFAULT_MAX_INLINE_BYTES } from "@sweatpants/durable-execution";
import { stableTupleHash, type Json } from "@sweatpants/foundation";

import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  AuthorityState,
  AuthoritySessionState,
  TaskState,
  PullState,
} from "../contract/authority-contract.ts";
import { signCapability, verifyProgramCapability } from "../contract/capabilities.ts";
import {
  cloneTaskState,
  taskOriginSession,
  type DraftSession,
  type DraftState,
  type DraftTask,
} from "./decision-state.ts";
import { parseRegisteredSchema } from "../contract/schema-registry.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import { normalizeEmissionPolicy } from "../state/authority-support.ts";
import { signResolutionCapability } from "./resolution-capability.ts";
import type { SemanticEmissionPolicy } from "../state/authority-snapshot.ts";

export interface AuthorityDecisionOptions {
  readonly maxOutcomeBytes?: number;
  readonly emissionPolicy?: SemanticEmissionPolicy;
}

/** Reads retain accepted state. Mutable access owns a copy of only that branch.
 * Acquiring a mutable branch declares a change; perform no-op guards before it.
 */
export class DecisionDraft {
  private current: AuthorityState;
  private readonly accepted: AuthorityState;
  readonly entries: DurableSemanticRecord[] = [];
  readonly context: AuthorityDecisionFrame<AuthorityCommand>["context"];
  readonly maxOutcomeBytes: number;
  readonly emissionPolicy: SemanticEmissionPolicy | undefined;
  readonly offsets = new Map<string, number>();

  constructor(frame: AuthorityDecisionFrame<AuthorityCommand>, options: AuthorityDecisionOptions) {
    this.accepted = frame.state;
    this.current = frame.state;
    this.context = frame.context;
    this.maxOutcomeBytes = options.maxOutcomeBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.emissionPolicy = options.emissionPolicy
      ? normalizeEmissionPolicy(options.emissionPolicy)
      : undefined;
    this.offsets.set(frame.context.appendCursor.sessionId, frame.context.appendCursor.nextOffset);
  }

  get state(): AuthorityState {
    return this.current;
  }

  private editState(): DraftState {
    if (this.current === this.accepted) {
      this.current = {
        nextNonce: this.accepted.nextNonce,
        sessions: new Map(this.accepted.sessions),
      };
    }
    return this.current as DraftState;
  }

  readSession(sessionId: string): AuthoritySessionState {
    return (
      this.current.sessions.get(sessionId) ?? {
        execution: { tasks: new Map() },
        control: {
          journalHeadId: null,
          runnable: false,
          revision: 0,
          nextRootOrdinal: 0,
          lastActivationEpoch: 0,
          consecutiveRestoreStales: 0,
        },
      }
    );
  }

  readTask(sessionId: string, taskId: string): TaskState {
    const task = this.current.sessions.get(sessionId)?.execution.tasks.get(taskId);
    if (task === undefined) {
      throw new CrankError("unknown_target", `Unknown task ${taskId}`);
    }
    return task;
  }

  session(sessionId: string): DraftSession {
    const state = this.editState();
    let session = state.sessions.get(sessionId);
    if (session === undefined || session === this.accepted.sessions.get(sessionId)) {
      const source = this.readSession(sessionId);
      session = {
        control: structuredClone(source.control),
        execution: { tasks: new Map(source.execution.tasks) },
      };
      state.sessions.set(sessionId, session);
    }
    return session as DraftSession;
  }

  task(sessionId: string, taskId: string): DraftTask {
    const session = this.session(sessionId);
    let task = session.execution.tasks.get(taskId);
    if (task === undefined) {
      throw new CrankError("unknown_target", `Unknown task ${taskId}`);
    }
    if (task === this.accepted.sessions.get(sessionId)?.execution.tasks.get(taskId)) {
      task = cloneTaskState(task);
      session.execution.tasks.set(taskId, task);
    }
    return task as DraftTask;
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
      /* CONDITIONAL-SPREAD: Omit absent ownerEpoch from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
      ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
      payload,
    });
    this.session(sessionId).control.revision += 1;
    return offset;
  }

  nonce(): string {
    this.editState().nextNonce += 1;
    return stableTupleHash(["nonce", this.context.journalIdentity.id, this.state.nextNonce]);
  }

  programCapability(task: TaskState, deterministicNonce?: string): string {
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

  resolutionCapability(task: TaskState, pull: PullState, attemptId: string | undefined): string {
    return signResolutionCapability({
      context: this.context,
      state: this.state,
      task,
      pull,
      /* CONDITIONAL-SPREAD: Omit absent attemptId from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
      ...(attemptId === undefined ? {} : { attemptId }),
      nonce: this.nonce(),
    });
  }

  assertActive(task: TaskState): void {
    if (task.lifecycle.status !== "active") {
      throw new CrankError("task_terminal");
    }
  }

  assertProgram(token: string, task: TaskState, sessionId: string): void {
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
    if (validated.status === "unavailable") {
      throw new CrankError("schema_version_unavailable");
    }
    if (validated.status === "invalid" || validated.status === "schema-error") {
      throw new CrankError(errorCode);
    }
    return validated.value;
  }
}
