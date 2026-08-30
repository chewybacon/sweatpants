import { run } from "effection";
import { describe, it } from "vitest";

import { createMemoryExecutionStore } from "../store/memory.ts";
import { createStoredScenarioDriver } from "../testing/stored-scenario-driver.ts";
import {
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/conformance.ts";

const store = createMemoryExecutionStore();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "memory-execution-store",
  *open(options) {
    return createStoredScenarioDriver(store, {
      journalId: options.journalId,
      journalIncarnation: "conformance-v1",
      keyring: options.keyring,
      now: options.now,
      schemaRegistry: options.schemaRegistry,
    });
  },
};

describe("JournalAuthority over the memory Execution Store", () => {
  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
