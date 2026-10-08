import { definePort, type PortFacade } from "@sweatpants/foundation/port";
import type { Operation } from "effection";

import { ExecutionStorePort } from "../api.ts";
import type { InMemoryJournalAuthorityOptions } from "../state/authority-snapshot.ts";
import { createInMemoryJournal } from "../shell/in-memory-journal.ts";
import {
  createJournal,
  type Journal,
  type StoredJournalAuthorityOptions,
} from "../shell/journal.ts";
import type {
  AuthorityJournalContract,
  AuthoritySnapshotContract,
  JournalAuthorityContract,
} from "./authority-contract.ts";

export class JournalAuthorityUnavailable extends Error {
  readonly code = "unknown_target";

  constructor() {
    super("No journal authority driver is installed");
    this.name = "JournalAuthorityUnavailable";
  }
}

function* unavailableOperation(): Operation<never> {
  throw new JournalAuthorityUnavailable();
}

export const JournalAuthorityPort = definePort<JournalAuthorityContract>("journal-authority", {
  command: unavailableOperation,
  query: unavailableOperation,
});

export const AuthorityJournalPort = definePort<AuthorityJournalContract>("authority-journal", {
  readSession: unavailableOperation,
  readTree: unavailableOperation,
});

/** Explicit administrative/test state-transfer boundary; not an AuthorityQuery. */
export const AuthoritySnapshotPort = definePort<AuthoritySnapshotContract>("authority-snapshot", {
  exportSnapshot: unavailableOperation,
});

export type JournalAuthorityFacade = PortFacade<JournalAuthorityContract>;
export type AuthorityJournalFacade = PortFacade<AuthorityJournalContract>;
export type AuthoritySnapshotFacade = PortFacade<AuthoritySnapshotContract>;

/** Read the installed journal capability, retaining current-scope middleware. */
export function* useJournal(): Operation<Journal> {
  const authority = yield* JournalAuthorityPort.use();
  const records = yield* AuthorityJournalPort.use();
  const snapshot = yield* AuthoritySnapshotPort.use();
  return {
    advance: authority.command,
    query: authority.query,
    readSession: records.readSession,
    readTree: records.readTree,
    exportSnapshot: snapshot.exportSnapshot,
  };
}

/** Bind a journal resource at the transport/workflow port boundary. */
export function* installJournal(journal: Journal): Operation<void> {
  yield* JournalAuthorityPort.installDriver({
    command: journal.advance,
    query: journal.query,
  });
  yield* AuthorityJournalPort.installDriver(journal);
  yield* AuthoritySnapshotPort.installDriver(journal);
}

export function* installInMemoryJournalAuthority(
  options: InMemoryJournalAuthorityOptions,
): Operation<void> {
  const journal = yield* createInMemoryJournal(options);
  yield* installJournal(journal);
}

export function* installStoredJournalAuthority(
  options: StoredJournalAuthorityOptions,
): Operation<void> {
  // The facade resolves storage middleware and overrides in each caller's scope.
  const journal = yield* createJournal(ExecutionStorePort.api.operations, options);
  yield* installJournal(journal);
}
