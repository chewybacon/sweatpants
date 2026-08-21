import { definePort, type PortFacade } from "@sweatpants/foundation/port";
import type { Operation } from "effection";

import { ExecutionStorePort } from "./api.ts";
import type { InMemoryJournalAuthorityOptions } from "./authority-snapshot.ts";
import { createInMemoryShellDrivers } from "./in-memory-shell.ts";
import { createStoredShellDrivers, type StoredJournalAuthorityOptions } from "./stored-shell.ts";
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

export function* installInMemoryJournalAuthority(
  options: InMemoryJournalAuthorityOptions,
): Operation<void> {
  const drivers = createInMemoryShellDrivers(options);
  yield* JournalAuthorityPort.installDriver(drivers.authority);
  yield* AuthorityJournalPort.installDriver(drivers.journal);
  yield* AuthoritySnapshotPort.installDriver(drivers.snapshot);
}

export function* installStoredJournalAuthority(
  options: StoredJournalAuthorityOptions,
): Operation<void> {
  const store = yield* ExecutionStorePort.use();
  const drivers = createStoredShellDrivers(store, options);
  yield* JournalAuthorityPort.installDriver(drivers.authority);
  yield* AuthorityJournalPort.installDriver(drivers.journal);
  yield* AuthoritySnapshotPort.installDriver(drivers.snapshot);
}
