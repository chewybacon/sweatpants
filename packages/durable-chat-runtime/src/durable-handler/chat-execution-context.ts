import type { ResolvedDurableChatComposition } from "./configuration.ts";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import type { ResolvedChatStorage } from "./storage.ts";
import type { LiveProgramActivation } from "./turn-recovery.ts";
import type { DurableChatHandlerConfig } from "./types.ts";

export interface ChatExecutionContext {
  config: DurableChatHandlerConfig;
  storage: ResolvedChatStorage;
  projectionTokens: ResolvedDurableChatComposition["projectionTokens"];
  programDriverJournalStore: ProgramDriverJournalStore;
  liveProgramActivations: Map<string, LiveProgramActivation>;
}
