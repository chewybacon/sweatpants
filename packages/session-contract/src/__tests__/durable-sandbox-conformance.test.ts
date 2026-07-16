import { run } from "effection";
import { describe, it } from "vitest";

import {
  createInMemoryDurableJournalAuthority,
  type InMemoryDurableJournalAuthority,
} from "../durable-authority.ts";
import {
  adaptInMemoryAuthorityForSandboxConformance,
  createDurableSandboxConformanceCases,
  type DurableSandboxConformanceFactory,
} from "../testing/durable-sandbox-conformance.ts";

const authorities = new Map<string, InMemoryDurableJournalAuthority>();
const factory: DurableSandboxConformanceFactory = {
  backendName: "in-memory",
  *open(options) {
    let authority = authorities.get(options.journalId);
    if (!authority) {
      authority = createInMemoryDurableJournalAuthority({
        journalId: options.journalId,
        journalIncarnation: "sandbox-conformance-v1",
        keyring: options.keyring,
        now: () => 1_000,
      });
      authorities.set(options.journalId, authority);
    }
    return adaptInMemoryAuthorityForSandboxConformance(authority);
  },
};

describe("durable sandbox in-memory conformance", () => {
  for (const conformanceCase of createDurableSandboxConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
