import { run } from "effection";
import { describe, it } from "vitest";

import {
  createInMemoryDurableJournalAuthority,
  type InMemoryDurableJournalAuthority,
} from "../durable-authority.ts";
import {
  adaptInMemoryAuthorityForConformance,
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/journal-authority-conformance.ts";

const authorities = new Map<string, InMemoryDurableJournalAuthority>();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "in-memory",
  *open(options) {
    let authority = authorities.get(options.journalId);
    if (!authority) {
      authority = createInMemoryDurableJournalAuthority({
        journalId: options.journalId,
        journalIncarnation: "conformance-v1",
        keyring: options.keyring,
        now: () => 1_000,
      });
      authorities.set(options.journalId, authority);
    }
    return adaptInMemoryAuthorityForConformance(authority);
  },
};

describe("JournalAuthority in-memory conformance", () => {
  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
