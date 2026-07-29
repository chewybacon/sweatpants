import { CrankError } from "@sweatpants/durable-execution";
import { sortedResourceValues } from "@sweatpants/agent-sdk";
import { canonicalJson, canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { DEFAULT_MAX_INLINE_BYTES } from "@sweatpants/durable-execution";
import {
  CHAT_CONTEXT_POLICY_FORMAT,
  CHAT_TURN_INPUT_FORMAT,
  normalizeChatMessage,
  normalizeChatTurnInput,
  type ChatContextPolicyV1,
  type ChatContextViewV1,
  type ChatMessageV1,
  type ChatTurnInputV1,
  type ReferencedTaskSummaryV1,
} from "./contracts.ts";

export const CHAT_CONTEXT_POLICY_DOMAIN = `${CHAT_CONTEXT_POLICY_FORMAT}\n`;
export const DEFAULT_CHAT_CONTEXT_LIMITS = Object.freeze({
  maxMessages: 64,
  maxReferencedTasks: 32,
  maxCanonicalBytes: 512 * 1024,
});
export const CHAT_INPUT_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * Host-supplied journal projection at one already captured frontier.
 *
 * This pure selector does not hold journal authority and therefore cannot prove
 * that `messages` and `referencedTasks` came from `frontier`. The accepting host
 * MUST read all candidates from one fixed pre-open frontier and MUST persist the
 * returned view in TaskOpened input. Spec-3 host concurrency tests own that
 * frontier/candidate binding; replay of an accepted task must not call this
 * selector again.
 */
export interface ChatContextSelectionInput {
  readonly frontier: string;
  readonly referenceTaskIds?: readonly string[];
  readonly referencedTasks?: readonly ReferencedTaskSummaryV1[];
  readonly latestSummary?: ChatMessageV1;
  readonly messages?: readonly ChatMessageV1[];
}

export function latestContextWindow(
  input: Partial<Omit<ChatContextPolicyV1, "format" | "digest">> = {},
): ChatContextPolicyV1 {
  const allowed = new Set([
    "id",
    "version",
    "maxMessages",
    "maxReferencedTasks",
    "maxCanonicalBytes",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    invalidPolicy("context policy uses an unknown field");
  }
  const projection = {
    format: CHAT_CONTEXT_POLICY_FORMAT,
    id: input.id ?? "latest-explicit-first",
    version: input.version ?? "1",
    maxMessages: input.maxMessages ?? DEFAULT_CHAT_CONTEXT_LIMITS.maxMessages,
    maxReferencedTasks: input.maxReferencedTasks ?? DEFAULT_CHAT_CONTEXT_LIMITS.maxReferencedTasks,
    maxCanonicalBytes: input.maxCanonicalBytes ?? DEFAULT_CHAT_CONTEXT_LIMITS.maxCanonicalBytes,
  };
  for (const [key, value] of Object.entries(projection)) {
    if (
      ["maxMessages", "maxReferencedTasks", "maxCanonicalBytes"].includes(key) &&
      (!Number.isSafeInteger(value) || Number(value) <= 0)
    ) {
      invalidPolicy(`${key} must be a positive safe integer`);
    }
  }
  if (
    !projection.id ||
    !projection.version ||
    projection.maxCanonicalBytes > DEFAULT_MAX_INLINE_BYTES - CHAT_INPUT_ENVELOPE_RESERVE_BYTES
  ) {
    invalidPolicy("context policy exceeds the journal input envelope");
  }
  return deepFreeze({
    ...projection,
    digest: sha256(CHAT_CONTEXT_POLICY_DOMAIN + canonicalJson(projection)),
  });
}

export function selectChatContext(
  policy: ChatContextPolicyV1,
  input: ChatContextSelectionInput,
): ChatContextViewV1 {
  validatePolicy(policy);
  if (
    typeof input.frontier !== "string" ||
    input.frontier.length === 0 ||
    input.frontier.length > 512
  ) {
    invalidPolicy("invalid context frontier");
  }
  const referenceTaskIds: string[] = [];
  const seenReferences = new Set<string>();
  for (const raw of input.referenceTaskIds ?? []) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
      invalidPolicy("invalid reference task ID");
    }
    if (!seenReferences.has(raw)) {
      seenReferences.add(raw);
      referenceTaskIds.push(raw);
    }
  }
  const summaries = new Map(
    (input.referencedTasks ?? []).map((item) => [item.taskId, normalizeSummary(item)]),
  );
  const selectedReferences: ReferencedTaskSummaryV1[] = [];
  const selectedMessages: ChatMessageV1[] = [];
  let omittedReferencedTasks = 0;
  let omittedMessages = 0;

  const fits = (nextRefs: ReferencedTaskSummaryV1[], nextMessages: ChatMessageV1[]) => {
    const candidate = baseView(policy, input.frontier, referenceTaskIds, nextRefs, nextMessages, {
      // Reserve the maximum decimal width so final omission counts cannot
      // push an accepted context over its canonical byte budget.
      omittedMessages: Number.MAX_SAFE_INTEGER,
      omittedReferencedTasks: Number.MAX_SAFE_INTEGER,
    });
    return byteLength(candidate as unknown as Json) <= policy.maxCanonicalBytes;
  };
  for (const id of referenceTaskIds) {
    const summary = summaries.get(id);
    if (!summary) {
      omittedReferencedTasks += 1;
      continue;
    }
    if (
      selectedReferences.length >= policy.maxReferencedTasks ||
      !fits([...selectedReferences, summary], selectedMessages)
    ) {
      omittedReferencedTasks += 1;
      continue;
    }
    selectedReferences.push(summary);
  }

  const normalizedMessages = (input.messages ?? []).map(normalizeChatMessage);
  const latestSummary = input.latestSummary ? normalizeChatMessage(input.latestSummary) : undefined;
  if (latestSummary && normalizedMessages.every((message) => message.id !== latestSummary.id)) {
    if (policy.maxMessages > 0 && fits(selectedReferences, [latestSummary])) {
      selectedMessages.push(latestSummary);
    } else {
      omittedMessages += 1;
    }
  }
  const already = new Set(selectedMessages.map((message) => message.id));
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const message = normalizedMessages[index]!;
    if (already.has(message.id)) {
      continue;
    }
    if (
      selectedMessages.length >= policy.maxMessages ||
      !fits(selectedReferences, [message, ...selectedMessages])
    ) {
      omittedMessages += 1;
      continue;
    }
    selectedMessages.unshift(message);
    already.add(message.id);
  }
  if (latestSummary) {
    const summaryIndex = selectedMessages.findIndex((message) => message.id === latestSummary.id);
    if (summaryIndex > 0) {
      const [summary] = selectedMessages.splice(summaryIndex, 1);
      selectedMessages.unshift(summary!);
    }
  }
  return deepFreeze(
    baseView(policy, input.frontier, referenceTaskIds, selectedReferences, selectedMessages, {
      omittedMessages,
      omittedReferencedTasks,
    }),
  );
}

export function acceptChatTurn(
  policy: ChatContextPolicyV1,
  messageValue: ChatMessageV1,
  selection: ChatContextSelectionInput,
  maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
): ChatTurnInputV1 {
  const message = normalizeChatMessage(messageValue);
  const context = selectChatContext(policy, selection);
  const accepted = normalizeChatTurnInput({ format: CHAT_TURN_INPUT_FORMAT, message, context });
  if (byteLength(accepted as unknown as Json) > maxInlineBytes) {
    throw new CrankError(
      "chat_context_too_large",
      "Accepted chat turn exceeds the journal inline-input bound",
    );
  }
  return accepted;
}

export function chatPayloadClassifications(input: {
  readonly systemPrompt: { readonly provenance: { readonly classifications: readonly string[] } };
  readonly messages: readonly ChatMessageV1[];
}): Array<"public" | "internal" | "confidential" | "restricted"> {
  const values = new Set<string>(input.systemPrompt.provenance.classifications);
  for (const message of input.messages) {
    for (const part of message.parts) {
      for (const classification of part.provenance.classifications) {
        values.add(classification);
      }
    }
  }
  const result = sortedResourceValues(values, (left, right) => left.localeCompare(right));
  if (
    result.some((value) => !["public", "internal", "confidential", "restricted"].includes(value))
  ) {
    invalidPolicy("invalid payload classification");
  }
  return result as Array<"public" | "internal" | "confidential" | "restricted">;
}

function baseView(
  policy: ChatContextPolicyV1,
  frontier: string,
  referenceTaskIds: string[],
  referencedTasks: ReferencedTaskSummaryV1[],
  messages: ChatMessageV1[],
  truncation: ChatContextViewV1["truncation"],
): ChatContextViewV1 {
  return canonicalSnapshot({
    policyDigest: policy.digest,
    frontier,
    referenceTaskIds,
    referencedTasks,
    messages,
    truncation,
  } as unknown as Json).value as unknown as ChatContextViewV1;
}
function normalizeSummary(value: ReferencedTaskSummaryV1): ReferencedTaskSummaryV1 {
  if (
    !value ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    value.taskId.length > 512
  ) {
    invalidPolicy("invalid referenced task summary");
  }
  return deepFreeze({ taskId: value.taskId, summary: normalizeChatMessage(value.summary) });
}
function validatePolicy(policy: ChatContextPolicyV1): void {
  const rebuilt = latestContextWindow({
    id: policy.id,
    version: policy.version,
    maxMessages: policy.maxMessages,
    maxReferencedTasks: policy.maxReferencedTasks,
    maxCanonicalBytes: policy.maxCanonicalBytes,
  });
  if (rebuilt.digest !== policy.digest || policy.format !== CHAT_CONTEXT_POLICY_FORMAT) {
    invalidPolicy("context policy digest mismatch");
  }
}
function byteLength(value: Json): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}
function invalidPolicy(message: string): never {
  throw new CrankError("invalid_chat_program", message);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
