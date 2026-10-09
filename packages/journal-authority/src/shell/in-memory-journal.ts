import { advanceJournalHeadIdentities } from "./journal-head-identity.ts";
import { hasLiveDurablePull, signalLiveDurablePull } from "@sweatpants/durable-effects/runtime";
import { verifyResolutionCapability } from "../contract/capabilities.ts";
import { resource, type Operation } from "effection";
import type { Journal } from "./journal.ts";

import { createDurableSchemaRegistry } from "../contract/schema-registry.ts";
import type {
  AuthorityCommand,
  AuthorityQuery,
  AuthorityState,
  CommandResult,
  KernelContext,
  QueryResult,
} from "../contract/authority-contract.ts";
import {
  authorityStateFromSnapshot,
  snapshotFromAuthorityState,
} from "../state/authority-state.ts";
import { queryAuthorityState } from "../decisions/authority-decisions.ts";
import { structuralCommandSessionId } from "../contract/authority-command-address.ts";
import { decideAuthorityTransition } from "../decisions/decision-pipeline.ts";
import type {
  DurableAuthoritySnapshot,
  InMemoryJournalAuthorityOptions,
} from "../state/authority-snapshot.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";

/** A journal whose accepted state and history belong to the acquiring scope. */
export function createInMemoryJournal(
  options: InMemoryJournalAuthorityOptions,
): Operation<Journal> {
  return resource(function* (provide) {
    let open = true;
    function assertOpen() {
      if (!open) {
        throw new Error("Journal owning scope has exited");
      }
    }
    const initial = options.snapshot ?? emptySnapshot();
    let state = authorityStateFromSnapshot(initial);
    let history = initial.records.flatMap(([, records]) => structuredClone(records));
    const identity = {
      id: options.journalId,
      incarnation: options.journalIncarnation ?? "1",
    };

    const journal: Journal = {
      *advance<C extends AuthorityCommand>(input: C): Operation<CommandResult<C>> {
        assertOpen();
        const command = structuredClone(input);
        const selectedState = state;
        const selectedHistory = history;
        const sessionId = commandSessionId(command, selectedState, options);
        const context: KernelContext = {
          nowMs: options.now?.() ?? Date.now(),
          journalIdentity: identity,
          appendCursor: { sessionId, nextOffset: nextOffset(selectedHistory, sessionId) },
          journalHeadId: selectedState.sessions.get(sessionId)?.control.journalHeadId ?? "",
          keyring: options.keyring,
          schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
          maxOutcomeBytes: options.maxOutcomeBytes,
          emissionPolicy: options.emissionPolicy,
          decisionDiagnostics: options.decisionDiagnostics,
          liveEffectTargets: liveEffectTargets(selectedState),
        };
        const transition = decideAuthorityTransition({
          state: selectedState,
          context,
          command,
        });
        if (transition.kind === "unchanged") {
          signalCommittedCancellation(command, transition.state);
          return structuredClone(transition.result);
        }
        state = advanceJournalHeadIdentities(transition.state, transition.entries);
        history = [...selectedHistory, ...structuredClone(transition.entries)];
        signalCommittedCancellation(command, transition.state);
        return structuredClone(transition.result);
      },
      *query<Q extends AuthorityQuery>(query: Q): Operation<QueryResult<Q>> {
        assertOpen();
        return queryAuthorityState(
          state,
          {
            nowMs: options.now?.() ?? Date.now(),
            journalIdentity: identity,
            appendCursor: { sessionId: "", nextOffset: 0 },
            journalHeadId: "",
            keyring: options.keyring,
            schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
            maxOutcomeBytes: options.maxOutcomeBytes,
            emissionPolicy: options.emissionPolicy,
            decisionDiagnostics: options.decisionDiagnostics,
          },
          query,
        );
      },

      *readSession(sessionId) {
        assertOpen();
        return structuredClone(history.filter((record) => record.sessionId === sessionId));
      },
      *readTree(sessionId, rootTaskId) {
        assertOpen();
        const records = history.filter((record) => record.sessionId === sessionId);
        const taskIds = new Set([rootTaskId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const record of records) {
            if (
              record.payload.type === "TaskOpened" &&
              record.payload.parentTaskId &&
              taskIds.has(record.payload.parentTaskId) &&
              !taskIds.has(record.payload.taskId)
            ) {
              taskIds.add(record.payload.taskId);
              changed = true;
            }
          }
        }
        return structuredClone(records.filter((record) => taskIds.has(record.payload.taskId)));
      },

      *exportSnapshot() {
        assertOpen();
        return snapshotFromAuthorityState(state, groupHistory(history));
      },
    };
    try {
      yield* provide(journal);
    } finally {
      open = false;
      state = authorityStateFromSnapshot(emptySnapshot());
      history = [];
    }
  });
}

function commandSessionId(
  command: AuthorityCommand,
  state: AuthorityState,
  options: InMemoryJournalAuthorityOptions,
): string {
  const structural = structuralCommandSessionId(command);
  if (structural !== undefined) {
    return structural;
  }
  if (command.type === "execution.resolve-pull") {
    try {
      return verifyResolutionCapability(
        command.request.capability,
        options.keyring,
        command.request.audience,
      ).sessionId;
    } catch {
      return "";
    }
  }
  if (
    command.type === "execution.accept-preparation" ||
    command.type === "execution.accept-assistant-partial"
  ) {
    for (const [sessionId, session] of state.sessions) {
      if (session.execution.tasks.has(command.request.taskId)) {
        return sessionId;
      }
    }
  }
  return "";
}

function nextOffset(records: readonly DurableSemanticRecord[], sessionId: string): number {
  let next = 0;
  for (const record of records) {
    if (record.sessionId !== sessionId) {
      continue;
    }
    const offset = Number(record.offset);
    if (Number.isSafeInteger(offset)) {
      next = Math.max(next, offset + 1);
    }
  }
  return next;
}

function groupHistory(
  records: readonly DurableSemanticRecord[],
): Array<[string, readonly DurableSemanticRecord[]]> {
  const groups = new Map<string, DurableSemanticRecord[]>();
  for (const record of records) {
    const values = groups.get(record.sessionId) ?? [];
    values.push(record);
    groups.set(record.sessionId, values);
  }
  return [...groups.entries()];
}

function liveEffectTargets(state: AuthorityState): readonly { taskId: string; pullId: string }[] {
  const targets: { taskId: string; pullId: string }[] = [];
  for (const [sessionId, session] of state.sessions) {
    for (const task of session.execution.tasks.values()) {
      for (const action of task.actions) {
        if (
          action.kind === "pull" &&
          action.pull.resolution.status === "open" &&
          hasLiveDurablePull(sessionId, task.taskId, action.pull.pullId)
        ) {
          targets.push({ taskId: task.taskId, pullId: action.pull.pullId });
        }
      }
    }
  }
  return targets;
}

function signalCommittedCancellation<C extends AuthorityCommand>(
  command: C,
  state: AuthorityState,
): void {
  if (command.type !== "execution.request-cancellation") {
    return;
  }
  const session = state.sessions.get(command.request.sessionId);
  if (!session) {
    return;
  }
  for (const task of session.execution.tasks.values()) {
    const lifecycle = task.lifecycle;
    if (lifecycle.status !== "active" || lifecycle.cancellation.type !== "settling_pull") {
      continue;
    }
    const pullId = lifecycle.cancellation.pullId;
    if (hasLiveDurablePull(command.request.sessionId, task.taskId, pullId)) {
      signalLiveDurablePull(
        command.request.sessionId,
        task.taskId,
        pullId,
        lifecycle.cancellation.reason,
      );
    }
  }
}

function emptySnapshot(): DurableAuthoritySnapshot {
  return { version: 1, sessions: [], nextNonce: 0, records: [] };
}
