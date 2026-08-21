import { run } from "effection";
import { describe, it } from "vitest";

import { createInMemoryShellDrivers } from "../in-memory-shell.ts";
import {
  adaptAuthorityPortsForConformance,
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/conformance.ts";

const authorities = new Map<string, ReturnType<typeof createInMemoryShellDrivers>>();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "in-memory",
  *open(options) {
    let authority = authorities.get(options.journalId);
    if (!authority) {
      authority = createInMemoryShellDrivers({
        journalId: options.journalId,
        journalIncarnation: "conformance-v1",
        keyring: options.keyring,
        now: options.now,
        schemaRegistry: options.schemaRegistry,
      });
      authorities.set(options.journalId, authority);
    }
    return adaptAuthorityPortsForConformance(authority.authority, authority.journal, {
      id: options.journalId,
      incarnation: "conformance-v1",
    });
  },
};

describe("JournalAuthority in-memory conformance", () => {
  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
