import { definePort } from "@sweatpants/foundation/port";
import type { Operation } from "effection";
import type {
  CheckpointPointer,
  CommandAdmissionRequest,
  CommandAdmissionResult,
  CommandReceipt,
  ConversationHead,
  ConversationStore,
  DurableCounter,
  HeadCommitResult,
  HistoryPointer,
  PublicArchivePage,
  PublicArchivePointer,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
  TerminalHistoryPage,
  ConversationHeadProposal,
} from "./contract.ts";

export class ConversationStoreUnavailable extends Error {
  readonly code = "conversation_store_unavailable";

  constructor() {
    super("No conversation store driver is installed");
    this.name = "ConversationStoreUnavailable";
  }
}

function unavailable(): never {
  throw new ConversationStoreUnavailable();
}

export const ConversationStorePort = definePort<ConversationStore>("conversation-store", {
  *loadHead(_conversationId: string): Operation<ConversationHead | null> {
    return unavailable();
  },
  *compareAndSwapHead(
    _conversationId: string,
    _expectedRevision: DurableCounter | null,
    _expectedOwnerEpoch: DurableCounter | null,
    _proposal: ConversationHeadProposal,
  ): Operation<HeadCommitResult> {
    return unavailable();
  },
  *admitCommand(_request: CommandAdmissionRequest): Operation<CommandAdmissionResult> {
    return unavailable();
  },
  *getCommandReceipt(
    _conversationId: string,
    _commandId: string,
  ): Operation<CommandReceipt | null> {
    return unavailable();
  },
  *putCheckpoint(_checkpoint: StoredCheckpoint): Operation<CheckpointPointer> {
    return unavailable();
  },
  *getCheckpoint(_pointer: CheckpointPointer): Operation<StoredCheckpoint | null> {
    return unavailable();
  },
  *putPublicArchiveSegment(_segment: StoredPublicArchiveSegment): Operation<PublicArchivePointer> {
    return unavailable();
  },
  *readPublicArchivePage(
    _conversationId: string,
    _cursor?: string,
    _limit?: number,
  ): Operation<PublicArchivePage> {
    return unavailable();
  },
  *putTerminalHistorySegment(_segment: StoredTerminalSegment): Operation<HistoryPointer> {
    return unavailable();
  },
  *readTerminalHistoryPage(
    _conversationId: string,
    _cursor?: string,
    _limit?: number,
  ): Operation<TerminalHistoryPage> {
    return unavailable();
  },
  *watchHead(
    _conversationId: string,
    _afterRevision: DurableCounter,
    _timeoutMs: number,
  ): Operation<ConversationHead | null> {
    return unavailable();
  },
});

export const ConversationStoreApi = ConversationStorePort.api;

export function installConversationStore(store: ConversationStore): Operation<void> {
  return ConversationStorePort.installDriver(store);
}
