import type { DurableEffectRegistration } from "@sweatpants/durable-effects";
import type { AdvancementResult } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import type { ConversationStreamEvent } from "@sweatpants/chat-core";

import type { ProgramDriverNativeToolComposition } from "../program-driver/native-tools.ts";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import type { WorkflowChatEngineParams } from "./types.ts";

export type StreamEvent = ConversationStreamEvent;

/** Product composition input. Execution and projection consume disjoint subsets. */
export type ProgramDriverChatEngineParams = WorkflowChatEngineParams & {
  journalStore: ProgramDriverJournalStore;
  foreignEffects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
  nativeTools?: ProgramDriverNativeToolComposition;
  continueAfterCancellation?: boolean;
  /** Host-owned delivery invoked only by the outer composition root. */
  liveEvent?: (event: StreamEvent) => import("effection").Operation<void>;
};

/** Private execution result handed across the execution → publication boundary. */
export interface ChatActivationReport {
  readonly before: DurableSemanticRecord[];
  readonly after: DurableSemanticRecord[];
  readonly outcome: AdvancementResult;
  readonly liveMessageIds: ReadonlySet<string>;
  readonly endedLiveMessageIds: ReadonlySet<string>;
  readonly cancellationFenceLost: boolean;
  readonly replacementQueued: boolean;
}
