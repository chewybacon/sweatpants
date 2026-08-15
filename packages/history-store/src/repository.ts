import {
  DURABLE_SCAN_MAX_BYTES,
  DURABLE_SCAN_MAX_RECORDS,
  DurableCollections,
  DurableIndexes,
  durableKey,
  type DurableKernel,
  type DurableMutationOutcome,
  type StoredImmutableRecord,
  type StoredScanPage,
} from "@sweatpants/durable-storage-kernel";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import {
  ConversationStoreError,
  type ArchivedPublicRootIndex,
  type CheckpointPointer,
  type CommandAdmissionResult,
  type CommandReceipt,
  type CommitConversationResult,
  type ConversationHead,
  type ConversationStore,
  type HeadCommitResult,
  type HistoryPointer,
  type PublicArchivePointer,
  type PublicHistoryReadPage,
  type ReadPublicHistoryBeforeRequest,
  type StoredCheckpoint,
  type StoredPublicArchiveSegment,
  type StoredTerminalSegment,
  type TerminalHistoryPage,
} from "./contract.ts";
import {
  checkpointEnsure,
  planCommandAdmission,
  planConversationCommit,
  planHeadCommit,
  publicSegmentEnsure,
  terminalSegmentEnsure,
} from "./planners.ts";
import { HistoryStoreReadObservationContext } from "./observation.ts";
import {
  conversationKeys,
  decodeArchivedPublicRootIndex,
  decodeAuthorityHead,
  decodeCheckpoint,
  decodeCommandReceipt,
  decodePublicSegment,
  decodeTerminalSegment,
} from "./persistence.ts";

function immutableConflict(
  outcome: Extract<DurableMutationOutcome, { status: "immutable_conflict" }>,
): never {
  const publicRoot = outcome.write.startsWith("public-root-");
  throw new ConversationStoreError(
    publicRoot ? "public_root_conflict" : "immutable_object_conflict",
    `Immutable conversation write ${outcome.write} conflicts with ${outcome.existing.key}`,
  );
}

function unexpected(outcome: never): never {
  throw new ConversationStoreError(
    "persisted_data_invalid",
    `Unexpected durable mutation outcome ${JSON.stringify(outcome)}`,
  );
}

function decodeCurrent(
  outcome: Extract<DurableMutationOutcome, { status: "authority_conflict" }>,
): ConversationHead | null {
  return outcome.current === null ? null : decodeAuthorityHead(outcome.current);
}

function counter(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ConversationStoreError("persisted_data_invalid", `${field} is not a durable counter`);
  }
  return BigInt(value);
}

function reversedCopy<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result.push(values[index]!);
  }
  return result;
}

function validatePageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new ConversationStoreError("persisted_data_invalid", `Invalid page limit ${limit}`);
  }
}

function ensureOutcome<T>(
  outcome: DurableMutationOutcome,
  name: string,
  decode: (value: Uint8Array) => T,
): T {
  if (outcome.status === "immutable_conflict") {
    return immutableConflict(outcome);
  }
  if (outcome.status !== "committed") {
    throw new ConversationStoreError(
      "persisted_data_invalid",
      `Ensure-only mutation returned ${outcome.status}`,
    );
  }
  const record = outcome.ensured[name];
  if (!record) {
    throw new ConversationStoreError(
      "persisted_data_invalid",
      `Committed mutation omitted ensured value ${name}`,
    );
  }
  return decode(record.value);
}

/**
 * Mandatory conversation semantics over a durable kernel. The kernel is a
 * construction capability and is never exposed through ConversationStore.
 */
export function createKernelConversationStore(kernel: DurableKernel): ConversationStore {
  function* loadHead(conversationId: string): Operation<ConversationHead | null> {
    const record = yield* kernel.readAuthority(
      DurableCollections.conversationHeads,
      conversationKeys.head(conversationId),
    );
    return record === null ? null : decodeAuthorityHead(record);
  }

  function* applyHeadMutation(
    mutation: Parameters<DurableKernel["apply"]>[0],
  ): Operation<HeadCommitResult> {
    const outcome = yield* kernel.apply(mutation);
    if (outcome.status === "committed") {
      if (outcome.authority === null) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Conversation commit omitted its authority result",
        );
      }
      return { status: "committed", head: decodeAuthorityHead(outcome.authority) };
    }
    if (outcome.status === "authority_conflict") {
      return { status: "head_conflict", current: decodeCurrent(outcome) };
    }
    if (outcome.status === "immutable_conflict") {
      return immutableConflict(outcome);
    }
    if (outcome.status === "claim_exists") {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        "Conversation publication unexpectedly contained a claim",
      );
    }
    return unexpected(outcome);
  }

  function* readTerminalChain(
    conversationId: string,
    head: HistoryPointer,
  ): Operation<readonly StoredTerminalSegment[]> {
    const reverse: StoredTerminalSegment[] = [];
    const seen = new Set<string>();
    let pointer: HistoryPointer | null = head;
    while (pointer !== null) {
      if (seen.has(pointer.segmentId)) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Terminal history chain contains a cycle at ${pointer.segmentId}`,
        );
      }
      seen.add(pointer.segmentId);
      const record = yield* kernel.readImmutable(
        DurableCollections.conversationTerminalSegments,
        conversationKeys.terminalSegment(pointer.segmentId),
      );
      if (record === null) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Terminal history chain points to missing segment ${pointer.segmentId}`,
        );
      }
      const segment = decodeTerminalSegment(record.value);
      if (
        segment.conversationId !== conversationId ||
        segment.lastPosition !== pointer.lastPosition
      ) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Terminal segment ${pointer.segmentId} is outside its selected frontier`,
        );
      }
      reverse.push(segment);
      pointer = segment.previous;
    }
    return reversedCopy(reverse);
  }

  function page<T extends { firstPosition: string; lastPosition: string }>(
    segments: readonly T[],
    cursor: string | undefined,
    limit: number,
    entries: (segment: T) => readonly Json[],
  ): { readonly values: readonly Json[]; readonly nextCursor: string | null } {
    validatePageLimit(limit);
    let expected: bigint | null = null;
    const values: Json[] = [];
    for (const segment of segments) {
      const first = counter(segment.firstPosition, "first position");
      const last = counter(segment.lastPosition, "last position");
      const body = entries(segment);
      if (last < first || last - first + 1n !== BigInt(body.length)) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Segment has an invalid position range",
        );
      }
      if (expected !== null && first !== expected) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Segment chain is not contiguous at ${expected}`,
        );
      }
      expected = last + 1n;
      values.push(...body);
    }
    const first =
      segments.length === 0 ? 0n : counter(segments[0]!.firstPosition, "first position");
    const start = cursor === undefined ? first : counter(cursor, "page cursor");
    const end = first + BigInt(values.length);
    if (start < first || start > end) {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        `Cursor ${start} is outside its selected history`,
      );
    }
    const offset = start - first;
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConversationStoreError("persisted_data_invalid", `Cursor ${start} is too large`);
    }
    const selected = values.slice(Number(offset), Number(offset) + limit);
    const next = start + BigInt(selected.length);
    return { values: selected, nextCursor: next < end ? next.toString(10) : null };
  }

  return {
    *loadHead(conversationId): Operation<ConversationHead | null> {
      return yield* loadHead(conversationId);
    },
    *compareAndSwapHead(
      conversationId,
      expectedRevision,
      expectedOwnerEpoch,
      proposal,
    ): Operation<HeadCommitResult> {
      const currentRecord = yield* kernel.readAuthority(
        DurableCollections.conversationHeads,
        conversationKeys.head(conversationId),
      );
      const decision = planHeadCommit({
        conversationId,
        currentRecord,
        expectedRevision,
        expectedOwnerEpoch,
        proposal,
        updatedAt: Date.now(),
      });
      if (decision.kind === "complete") {
        return decision.result;
      }
      return yield* applyHeadMutation(decision.mutation);
    },
    *commitConversation(request): Operation<CommitConversationResult> {
      const currentRecord = yield* kernel.readAuthority(
        DurableCollections.conversationHeads,
        conversationKeys.head(request.conversationId),
      );
      const decision = planConversationCommit({
        request,
        currentRecord,
        updatedAt: request.updatedAt ?? Date.now(),
      });
      if (decision.kind === "complete") {
        return decision.result;
      }
      const committed = yield* applyHeadMutation(decision.mutation);
      if (committed.status !== "committed") {
        return committed;
      }
      return {
        ...committed,
        ...(request.checkpoint
          ? { checkpoint: { checkpointId: request.checkpoint.checkpointId } }
          : {}),
        ...(request.terminalHistorySegment
          ? {
              terminalHistory: {
                segmentId: request.terminalHistorySegment.segmentId,
                lastPosition: request.terminalHistorySegment.lastPosition,
              },
            }
          : {}),
      };
    },
    *admitCommand(request): Operation<CommandAdmissionResult> {
      const observedReceipt = yield* kernel.readImmutable(
        DurableCollections.conversationCommandReceipts,
        conversationKeys.receipt(request.conversationId, request.commandId),
      );
      if (observedReceipt !== null) {
        const receipt = decodeCommandReceipt(observedReceipt.value);
        if (receipt.commandDigest !== request.commandDigest) {
          return { status: "command_identity_conflict", receipt };
        }
        const head = yield* loadHead(request.conversationId);
        if (head === null) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Command receipt exists without a conversation head",
          );
        }
        return { status: "idempotent", receipt, head };
      }
      const currentRecord = yield* kernel.readAuthority(
        DurableCollections.conversationHeads,
        conversationKeys.head(request.conversationId),
      );
      const decision = planCommandAdmission({ request, currentRecord });
      if (decision.kind === "complete") {
        return decision.result;
      }
      const outcome = yield* kernel.apply(decision.mutation);
      if (outcome.status === "committed") {
        if (outcome.authority === null) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Command admission committed without a conversation head",
          );
        }
        const receiptRecord = yield* kernel.readImmutable(
          DurableCollections.conversationCommandReceipts,
          conversationKeys.receipt(request.conversationId, request.commandId),
        );
        if (receiptRecord === null) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Command admission committed without a receipt",
          );
        }
        return {
          status: "admitted",
          receipt: decodeCommandReceipt(receiptRecord.value),
          head: decodeAuthorityHead(outcome.authority),
        };
      }
      if (outcome.status === "claim_exists") {
        const receipt = decodeCommandReceipt(outcome.existing.value);
        if (receipt.commandDigest !== request.commandDigest) {
          return { status: "command_identity_conflict", receipt };
        }
        const head = yield* loadHead(request.conversationId);
        if (head === null) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Command receipt exists without a conversation head",
          );
        }
        return { status: "idempotent", receipt, head };
      }
      if (outcome.status === "authority_conflict") {
        return { status: "head_conflict", current: decodeCurrent(outcome) };
      }
      if (outcome.status === "immutable_conflict") {
        return immutableConflict(outcome);
      }
      return unexpected(outcome);
    },
    *getCommandReceipt(conversationId, commandId): Operation<CommandReceipt | null> {
      const record = yield* kernel.readImmutable(
        DurableCollections.conversationCommandReceipts,
        conversationKeys.receipt(conversationId, commandId),
      );
      return record === null ? null : decodeCommandReceipt(record.value);
    },
    *putCheckpoint(checkpoint): Operation<CheckpointPointer> {
      const sameId = yield* kernel.readImmutable(
        DurableCollections.conversationCheckpoints,
        conversationKeys.checkpoint(checkpoint.checkpointId),
      );
      const sameCause = yield* kernel.readImmutable(
        DurableCollections.conversationCheckpoints,
        conversationKeys.checkpointCause(checkpoint.conversationId, checkpoint.causeKey),
      );
      const existing = sameId ?? sameCause;
      if (existing !== null) {
        if (existing.fingerprint !== checkpoint.contentHash) {
          throw new ConversationStoreError(
            "immutable_object_conflict",
            `Checkpoint ${checkpoint.conversationId}/${checkpoint.causeKey} has another content hash`,
          );
        }
        return { checkpointId: decodeCheckpoint(existing.value).checkpointId };
      }
      const ensure = checkpointEnsure(checkpoint);
      const outcome = yield* kernel.apply({ ensures: [ensure] });
      const stored = ensureOutcome(outcome, ensure.name, decodeCheckpoint);
      return { checkpointId: stored.checkpointId };
    },
    *getCheckpoint(pointer): Operation<StoredCheckpoint | null> {
      const record = yield* kernel.readImmutable(
        DurableCollections.conversationCheckpoints,
        conversationKeys.checkpoint(pointer.checkpointId),
      );
      return record === null ? null : decodeCheckpoint(record.value);
    },
    *putPublicArchiveSegment(segment): Operation<PublicArchivePointer> {
      const existing = yield* kernel.readImmutable(
        DurableCollections.conversationPublicSegments,
        conversationKeys.publicSegment(segment.segmentId),
      );
      if (existing !== null) {
        if (existing.fingerprint !== segment.contentHash) {
          throw new ConversationStoreError(
            "immutable_object_conflict",
            `Public archive segment ${segment.segmentId} has another content hash`,
          );
        }
        const stored = decodePublicSegment(existing.value);
        return { segmentId: stored.segmentId };
      }
      const ensure = publicSegmentEnsure(segment);
      const outcome = yield* kernel.apply({ ensures: [ensure] });
      const stored = ensureOutcome(outcome, ensure.name, decodePublicSegment);
      return { segmentId: stored.segmentId };
    },
    *readPublicHistoryBefore(
      request: ReadPublicHistoryBeforeRequest,
    ): Operation<PublicHistoryReadPage> {
      const observation = yield* HistoryStoreReadObservationContext.get();
      validatePageLimit(request.maxRoots);
      if (request.maxRoots > 256) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Public history maxRoots exceeds 256",
        );
      }
      if (
        !Number.isSafeInteger(request.maxBytes) ||
        request.maxBytes <= 0 ||
        request.maxBytes > 8 * 1024 * 1024
      ) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Invalid public history byte limit",
        );
      }
      const before = counter(request.beforePosition, "history before position");
      const lower =
        request.atOrAfterPosition === undefined
          ? 0n
          : counter(request.atOrAfterPosition, "history lower position");
      const nextPublic = counter(
        request.basis.nextPublicPosition,
        "history basis next public position",
      );
      const frontier = counter(
        request.basis.archiveFrontierOrdinal,
        "history basis archive frontier ordinal",
      );
      if (before > nextPublic || lower > before) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Public history position bounds are inconsistent",
        );
      }
      const hot = new Set<string>();
      for (const position of request.basis.hotRootPositions) {
        const parsed = counter(position, "history hot root position");
        if (parsed >= nextPublic || hot.has(position)) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Public history hot positions are invalid",
          );
        }
        hot.add(position);
      }
      if (hot.size > 256) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Public history basis exceeds 256 hot positions",
        );
      }

      const scan = yield* kernel.scan({
        collection: DurableCollections.conversationPublicRootIndex,
        index: DurableIndexes.conversationPosition,
        scope: durableKey(request.conversationId),
        direction: "backward",
        after: request.beforePosition,
        through: lower.toString(10),
        maxRecords: Math.min(DURABLE_SCAN_MAX_RECORDS, request.maxRoots + hot.size + 1),
        maxStoredBytes: DURABLE_SCAN_MAX_BYTES,
      });
      observation?.publicHistoryIndexPage(
        scan.records.length,
        scan.records.reduce((total, record) => total + record.storedBytes, 0),
      );
      const indexed: ArchivedPublicRootIndex[] = [];
      for (const record of scan.records) {
        const entry = decodeArchivedPublicRootIndex(record.value);
        if (entry.conversationId !== request.conversationId || entry.position !== record.position) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            "Public root index is outside its conversation or position",
          );
        }
        if (
          counter(entry.position, "public root position") >= nextPublic ||
          counter(entry.archiveOrdinal, "public root archive ordinal") >= frontier ||
          hot.has(entry.position)
        ) {
          continue;
        }
        indexed.push(entry);
        if (indexed.length > request.maxRoots) {
          break;
        }
      }

      const segmentCache = new Map<string, StoredPublicArchiveSegment>();
      const roots: Array<{ readonly position: string; readonly root: Json }> = [];
      let payloadBytes = 0;
      let hasMore = indexed.length > request.maxRoots || scan.nextCursor !== null;
      for (const entry of indexed.slice(0, request.maxRoots)) {
        if (entry.encodedBytes > 1024 * 1024) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            `Archived public root ${entry.rootId} exceeds the inline root bound`,
          );
        }
        if (roots.length > 0 && payloadBytes + entry.encodedBytes > request.maxBytes) {
          hasMore = true;
          break;
        }
        let segment = segmentCache.get(entry.segmentId);
        if (!segment) {
          const record = yield* kernel.readImmutable(
            DurableCollections.conversationPublicSegments,
            conversationKeys.publicSegment(entry.segmentId),
          );
          if (!record) {
            throw new ConversationStoreError(
              "persisted_data_invalid",
              `Public root index points to missing segment ${entry.segmentId}`,
            );
          }
          segment = decodePublicSegment(record.value);
          observation?.publicHistorySegment(segment.encodedBytes);
          segmentCache.set(entry.segmentId, segment);
        }
        const root = segment.roots[entry.segmentRootIndex];
        if (root === undefined) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            `Public root index points outside segment ${entry.segmentId}`,
          );
        }
        const rootObject =
          root !== null && typeof root === "object" && !Array.isArray(root) ? root : null;
        const snapshot = canonicalSnapshot(root);
        const bytes = new TextEncoder().encode(snapshot.canonical).byteLength;
        if (
          rootObject?.["rootId"] !== entry.rootId ||
          rootObject?.["position"] !== entry.position ||
          snapshot.sha !== entry.contentHash ||
          bytes !== entry.encodedBytes
        ) {
          throw new ConversationStoreError(
            "persisted_data_invalid",
            `Public root index conflicts with segment root ${entry.rootId}`,
          );
        }
        roots.push({ position: entry.position, root });
        payloadBytes += bytes;
      }
      observation?.publicHistoryPageMaterialized(payloadBytes);
      roots.sort((left, right) => {
        const a = counter(left.position, "public root position");
        const b = counter(right.position, "public root position");
        return a === b ? 0 : a < b ? -1 : 1;
      });
      return {
        roots: roots.map((entry) => entry.root),
        nextBeforePosition: hasMore && roots.length > 0 ? roots[0]!.position : null,
      };
    },

    *putTerminalHistorySegment(segment): Operation<HistoryPointer> {
      const sameId = yield* kernel.readImmutable(
        DurableCollections.conversationTerminalSegments,
        conversationKeys.terminalSegment(segment.segmentId),
      );
      const samePublication = yield* kernel.readImmutable(
        DurableCollections.conversationTerminalSegments,
        conversationKeys.terminalPublication(segment.conversationId, segment.publicationKey),
      );
      const existing = sameId ?? samePublication;
      if (existing !== null) {
        if (existing.fingerprint !== segment.contentHash) {
          throw new ConversationStoreError(
            "immutable_object_conflict",
            `Terminal segment ${segment.segmentId} has another content hash`,
          );
        }
        const stored = decodeTerminalSegment(existing.value);
        return { segmentId: stored.segmentId, lastPosition: stored.lastPosition };
      }
      const ensure = terminalSegmentEnsure(segment);
      const outcome = yield* kernel.apply({ ensures: [ensure] });
      const stored = ensureOutcome(outcome, ensure.name, decodeTerminalSegment);
      return { segmentId: stored.segmentId, lastPosition: stored.lastPosition };
    },
    *readTerminalHistoryPage(conversationId, cursor, limit = 50): Operation<TerminalHistoryPage> {
      const head = yield* loadHead(conversationId);
      let segments: readonly StoredTerminalSegment[];
      let historyHead: HistoryPointer | null;
      if (head === null) {
        const result: StoredImmutableRecord[] = [];
        let after: string | null = null;
        do {
          const scan: StoredScanPage = yield* kernel.scan({
            collection: DurableCollections.conversationTerminalSegments,
            index: DurableIndexes.conversationPosition,
            scope: durableKey(conversationId),
            direction: "forward",
            after,
            maxRecords: DURABLE_SCAN_MAX_RECORDS,
            maxStoredBytes: DURABLE_SCAN_MAX_BYTES,
          });
          result.push(...scan.records);
          after = scan.nextCursor;
        } while (after !== null);
        segments = result.map((record) => decodeTerminalSegment(record.value));
        const last = segments.at(-1);
        historyHead = last ? { segmentId: last.segmentId, lastPosition: last.lastPosition } : null;
      } else {
        historyHead = head.terminalHistory;
        segments =
          historyHead === null ? [] : yield* readTerminalChain(conversationId, historyHead);
      }
      const result = page(segments, cursor, limit, (segment) => segment.entries);
      return { entries: result.values, nextCursor: result.nextCursor, head: historyHead };
    },
    *watchHead(conversationId, afterRevision, timeoutMs): Operation<ConversationHead | null> {
      const current = yield* loadHead(conversationId);
      if (
        current &&
        counter(current.revision, "head revision") > counter(afterRevision, "wait revision")
      ) {
        return current;
      }
      yield* kernel.waitForChange({
        collection: DurableCollections.conversationHeads,
        key: conversationKeys.head(conversationId),
        afterRevision,
        timeoutMs,
      });
      const changed = yield* loadHead(conversationId);
      return changed &&
        counter(changed.revision, "head revision") > counter(afterRevision, "wait revision")
        ? changed
        : null;
    },
  };
}
