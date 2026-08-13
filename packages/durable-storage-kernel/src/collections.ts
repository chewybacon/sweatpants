export const DurableCollections = Object.freeze({
  conversationHeads: "conversation-heads",
  conversationCommandReceipts: "conversation-command-receipts",
  conversationCheckpoints: "conversation-checkpoints",
  conversationPublicSegments: "conversation-public-segments",
  conversationTerminalSegments: "conversation-terminal-segments",
  executionControls: "execution-controls",
  executionJournalSegments: "execution-journal-segments",
  executionReplaySegments: "execution-replay-segments",
  executionObjects: "execution-objects",
} as const);

export type AuthorityCollectionId =
  | typeof DurableCollections.conversationHeads
  | typeof DurableCollections.executionControls;

export type ImmutableCollectionId = Exclude<
  (typeof DurableCollections)[keyof typeof DurableCollections],
  AuthorityCollectionId
>;

export type OrderedCollectionId =
  | typeof DurableCollections.conversationPublicSegments
  | typeof DurableCollections.conversationTerminalSegments
  | typeof DurableCollections.executionJournalSegments
  | typeof DurableCollections.executionReplaySegments;

export const DurableIndexes = Object.freeze({
  conversationPosition: "conversation-position",
  taskSequence: "task-sequence",
} as const);

export type OrderedIndexId = (typeof DurableIndexes)[keyof typeof DurableIndexes];

const authorityCollections = new Set<string>([
  DurableCollections.conversationHeads,
  DurableCollections.executionControls,
]);
const immutableCollections = new Set<string>([
  DurableCollections.conversationCommandReceipts,
  DurableCollections.conversationCheckpoints,
  DurableCollections.conversationPublicSegments,
  DurableCollections.conversationTerminalSegments,
  DurableCollections.executionJournalSegments,
  DurableCollections.executionReplaySegments,
  DurableCollections.executionObjects,
]);

export function isAuthorityCollection(value: string): value is AuthorityCollectionId {
  return authorityCollections.has(value);
}

export function isImmutableCollection(value: string): value is ImmutableCollectionId {
  return immutableCollections.has(value);
}
