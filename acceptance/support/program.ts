import {
  ProgramDriverRegistryContext,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type ProgramDriver,
} from "@sweatpants/durable-execution";
import {
  createCapabilityKeyring,
  createJournal,
  driveProgramDriverActivation,
} from "@sweatpants/journal-authority";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import type { Json } from "@sweatpants/foundation";

export interface AcceptanceProgram {
  manifest: DurableProgramManifest;
  createDriver(): ProgramDriver;
}

/** Real journal + shared driver loop. Scenarios own commands and assertions. */
export function* useProgramRig(store: ExecutionStore, program: AcceptanceProgram, input: Json) {
  const journal = yield* createJournal(store, {
    journalId: "acceptance-program",
    keyring: createCapabilityKeyring("acceptance", [
      { keyId: "test", secret: "acceptance-program-secret-at-least-32-bytes" },
    ]),
  });
  const attach: AttachProgramRequest = {
    sessionId: "acceptance-program",
    taskId: "root",
    executionEpoch: 1,
    program: {
      id: program.manifest.programId,
      version: program.manifest.version,
      digest: program.manifest.digest,
    },
    input,
    route: { driverKind: "acceptance" },
  };
  return {
    journal,
    attach,
    *advance() {
      const driver = program.createDriver();
      return yield* ProgramDriverRegistryContext.with(
        new Map([["acceptance", driver]]),
        function* () {
          return yield* driveProgramDriverActivation({
            authority: {
              command: journal.advance.bind(journal),
              query: journal.query.bind(journal),
            },
            driver,
            attach,
            advancement: {},
          });
        },
      );
    },
  };
}
