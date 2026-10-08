import type { Journal } from "../shell/journal.ts";
import { run } from "effection";
import { describe, it } from "vitest";

import { createInMemoryJournal } from "../shell/in-memory-journal.ts";
import {
  adaptAuthorityPortsForConformance,
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/conformance.ts";

const authorities = new Map<string, Journal>();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "in-memory",
  *open(options) {
    let authority = authorities.get(options.journalId);
    if (!authority) {
      authority = yield* createInMemoryJournal({
        journalId: options.journalId,
        journalIncarnation: "conformance-v1",
        keyring: options.keyring,
        now: options.now,
        schemaRegistry: options.schemaRegistry,
      });
      authorities.set(options.journalId, authority);
    }
    return adaptAuthorityPortsForConformance(
      { command: authority.advance, query: authority.query },
      authority,
      {
        id: options.journalId,
        incarnation: "conformance-v1",
      },
    );
  },
};

describe("JournalAuthority in-memory conformance", () => {
  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
