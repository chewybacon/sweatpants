import { describe, expect, it } from "vitest";
import {
  PULL_KIND_EPHEMERAL,
  projectDurableExecution,
  type AdvancementPolicy,
  type AuthorityPort,
  type EffectRouter,
  type ExecutionComposition,
  type JournalSamplingService,
  type RootScope,
} from "@sweatpants/journal-authority";

/** App-level compile/runtime guard for the curated post-cutover spine surface. */
describe("durable execution spine surface", () => {
  it("exposes the required roles and active ephemeral vocabulary", () => {
    const roles = null as unknown as {
      authority: AuthorityPort;
      execution: ExecutionComposition;
      advancement: AdvancementPolicy;
      effects: EffectRouter;
      root: RootScope;
      sampling: JournalSamplingService;
    };
    expect(PULL_KIND_EPHEMERAL).toBe("ephemeral");
    expect(projectDurableExecution).toBeTypeOf("function");
    expect(roles).toBeNull();
  });
});
