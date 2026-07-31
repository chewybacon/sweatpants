/**
 * Chat history policy (F5).
 *
 * Explicit, opt-in owner for semantic history retention decisions: token/size
 * budgeting, turn-age compaction, and interrupted-call handling. The policy
 * runs before provider adaptation — the provider boundary (pi-ai) continues
 * to enforce wire validity only and never makes retention decisions.
 *
 * Default behavior (no policy installed): full preservation. Completed tool
 * call/result pairs are semantic causal records (REQ-038) and are never
 * silently dropped; a policy that removes them must record an explicit
 * decision for diagnostics.
 */
import { createContext } from "effection";
import type { Context as RuntimeContext, Message } from "@sweatpants/model-provider";

export interface HistoryPolicyDecision {
  /** What the policy did. */
  action: "drop_turn" | "drop_message";
  /** Human-readable reason, e.g. "message budget exceeded". */
  reason: string;
  /** Roles of the removed messages, in order. */
  roles: Message["role"][];
  /** Tool call ids removed with this decision (calls and their results). */
  toolCallIds: string[];
}

export interface HistoryPolicyInput {
  messages: Message[];
  systemPrompt?: string;
}

export interface HistoryPolicyResult {
  messages: Message[];
  decisions: HistoryPolicyDecision[];
}

export interface HistoryPolicy {
  /** Stable name surfaced with every diagnostic decision. */
  name: string;
  /** Pure retention decision. Must not mutate the input messages. */
  apply(input: HistoryPolicyInput): HistoryPolicyResult;
}

/**
 * Optional history policy for durable chat model requests. When unset, the
 * full projected history reaches the provider unchanged.
 */
export const HistoryPolicyContext = createContext<HistoryPolicy>("ChatHistoryPolicy");

/**
 * Apply an optional policy to a runtime context, returning the effective
 * context plus the decisions made (empty when no policy or nothing removed).
 */
export function applyHistoryPolicy(
  policy: HistoryPolicy | undefined,
  context: RuntimeContext,
): { context: RuntimeContext; decisions: HistoryPolicyDecision[] } {
  if (!policy) {
    return { context, decisions: [] };
  }
  const result = policy.apply({
    messages: context.messages,
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
  });
  if (result.decisions.length === 0) {
    return { context, decisions: [] };
  }
  return {
    context: { ...context, messages: result.messages },
    decisions: result.decisions,
  };
}

// =============================================================================
// REFERENCE POLICY: MESSAGE BUDGET
// =============================================================================

interface Turn {
  messages: Message[];
  toolCallIds: string[];
}

function toolCallIdsOf(message: Message): string[] {
  if (message.role === "assistant") {
    return message.content.flatMap((block) =>
      block.type === "toolCall" ? [block.toolCall.id] : [],
    );
  }
  if (message.role === "tool") {
    return [message.tool_call_id];
  }
  return [];
}

/**
 * Group non-system messages into turns. A turn starts at each user message;
 * assistant/tool messages belong to the preceding user turn so a
 * completed call/result pair can never be split across a retention boundary.
 */
function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const message of messages) {
    if (message.role === "user" || current === null) {
      current = { messages: [], toolCallIds: [] };
      turns.push(current);
    }
    current.messages.push(message);
    current.toolCallIds.push(...toolCallIdsOf(message));
  }
  return turns;
}

export interface MessageBudgetHistoryPolicyOptions {
  /**
   * Maximum number of non-system messages to send. Whole turns are dropped
   * from the oldest end until the budget holds; the most recent turn is
   * always retained even if it alone exceeds the budget.
   */
  maxMessages: number;
}

/**
 * Reference retention policy: keeps the newest complete turns within a
 * message budget. Never splits an assistant tool call from its result
 * (turn-granular removal), always preserves system messages and the latest
 * turn, and records one decision per dropped turn.
 */
export function createMessageBudgetHistoryPolicy(
  options: MessageBudgetHistoryPolicyOptions,
): HistoryPolicy {
  const { maxMessages } = options;
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new Error(`maxMessages must be a positive integer, got ${maxMessages}`);
  }
  return {
    name: "message-budget",
    apply({ messages }) {
      const system = messages.filter((message) => message.role === "system");
      const conversational = messages.filter((message) => message.role !== "system");
      if (conversational.length <= maxMessages) {
        return { messages, decisions: [] };
      }

      const turns = groupIntoTurns(conversational);
      const kept: Turn[] = [];
      let keptCount = 0;
      // Walk newest-first; always keep the newest turn.
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (kept.length > 0 && keptCount + turn.messages.length > maxMessages) {
          break;
        }
        kept.unshift(turn);
        keptCount += turn.messages.length;
      }

      const dropped = turns.slice(0, turns.length - kept.length);
      if (dropped.length === 0) {
        return { messages, decisions: [] };
      }

      const decisions: HistoryPolicyDecision[] = dropped.map((turn) => ({
        action: "drop_turn",
        reason: `message budget exceeded (${conversational.length} > ${maxMessages})`,
        roles: turn.messages.map((message) => message.role),
        toolCallIds: turn.toolCallIds,
      }));

      return {
        messages: [...system, ...kept.flatMap((turn) => turn.messages)],
        decisions,
      };
    },
  };
}
