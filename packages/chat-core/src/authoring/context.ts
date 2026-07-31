import { CrankError } from "@sweatpants/durable-execution";
import { sortedResourceValues } from "@sweatpants/agent-sdk";
import { canonicalJson, canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { DEFAULT_MAX_INLINE_BYTES } from "@sweatpants/durable-execution";
import {
  type AuthoredChatContextPolicy,
  type AuthoredChatContextView,
  type AuthoredChatMessage,
  type AuthoredChatTurnInput,
  type AuthoredReferencedTaskSummary,
} from "./contracts.ts";

export const AUTHORED_CHAT_CONTEXT_POLICY_DOMAIN = "sweatpants.chat-context-policy\n";
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
  readonly referencedTasks?: readonly AuthoredReferencedTaskSummary[];
  readonly latestSummary?: AuthoredChatMessage;
  readonly messages?: readonly AuthoredChatMessage[];
}

export function latestContextWindow(
  input: {
    readonly id?: string;
    readonly maxMessages?: number;
    readonly maxReferencedTasks?: number;
    readonly maxCanonicalBytes?: number;
  } = {},
): AuthoredChatContextPolicy {
  const allowed = new Set(["id", "maxMessages", "maxReferencedTasks", "maxCanonicalBytes"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    invalidPolicy("context policy uses an unknown field");
  }
  const projection = {
    id: input.id ?? "latest-explicit-first",
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
    projection.maxCanonicalBytes > DEFAULT_MAX_INLINE_BYTES - CHAT_INPUT_ENVELOPE_RESERVE_BYTES
  ) {
    invalidPolicy("context policy exceeds the journal input envelope");
  }
  return deepFreeze({
    ...projection,
    digest: sha256(AUTHORED_CHAT_CONTEXT_POLICY_DOMAIN + canonicalJson(projection)),
  });
}

export function selectChatContext(
  policy: AuthoredChatContextPolicy,
  input: ChatContextSelectionInput,
): AuthoredChatContextView {
  verifyChatContextPolicy(policy);
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
  const summaries = new Map((input.referencedTasks ?? []).map((item) => [item.taskId, item]));
  const selectedReferences: AuthoredReferencedTaskSummary[] = [];
  const selectedMessages: AuthoredChatMessage[] = [];
  let omittedReferencedTasks = 0;
  let omittedMessages = 0;

  const fits = (nextRefs: AuthoredReferencedTaskSummary[], nextMessages: AuthoredChatMessage[]) => {
    const candidate = baseView(policy, input.frontier, referenceTaskIds, nextRefs, nextMessages, {
      // Reserve the maximum decimal width so final omission counts cannot
      // push an accepted context over its canonical byte budget.
      omittedMessages: Number.MAX_SAFE_INTEGER,
      omittedReferencedTasks: Number.MAX_SAFE_INTEGER,
    });
    return byteLength(candidate) <= policy.maxCanonicalBytes;
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

  const normalizedMessages = [...(input.messages ?? [])];
  const latestSummary = input.latestSummary;
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
  policy: AuthoredChatContextPolicy,
  messageValue: AuthoredChatMessage,
  selection: ChatContextSelectionInput,
  maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
): AuthoredChatTurnInput {
  const message = messageValue;
  const context = selectChatContext(policy, selection);
  const accepted: AuthoredChatTurnInput = { message, context };
  if (byteLength(accepted) > maxInlineBytes) {
    throw new CrankError(
      "chat_context_too_large",
      "Accepted chat turn exceeds the journal inline-input bound",
    );
  }
  return accepted;
}

export function chatPayloadClassifications(input: {
  readonly systemPrompt: { readonly provenance: { readonly classifications: readonly string[] } };
  readonly messages: readonly AuthoredChatMessage[];
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
  policy: AuthoredChatContextPolicy,
  frontier: string,
  referenceTaskIds: string[],
  referencedTasks: AuthoredReferencedTaskSummary[],
  messages: AuthoredChatMessage[],
  truncation: AuthoredChatContextView["truncation"],
): AuthoredChatContextView {
  return canonicalSnapshot({
    policyDigest: policy.digest,
    frontier,
    referenceTaskIds,
    referencedTasks,
    messages,
    truncation,
  }).value;
}
function verifyChatContextPolicy(policy: AuthoredChatContextPolicy): void {
  const rebuilt = latestContextWindow({
    id: policy.id,
    maxMessages: policy.maxMessages,
    maxReferencedTasks: policy.maxReferencedTasks,
    maxCanonicalBytes: policy.maxCanonicalBytes,
  });
  if (rebuilt.digest !== policy.digest) {
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
