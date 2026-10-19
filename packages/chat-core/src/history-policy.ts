/**
 * Chat history retention policy applied to canonical Model Context messages.
 */
import { createContext } from "effection";
import type { ChatMessage } from "@sweatpants/chat-contract";
import type { ModelContext } from "@sweatpants/model-provider";

export interface HistoryPolicyDecision {
  action: "drop_turn" | "drop_message";
  reason: string;
  roles: ChatMessage["role"][];
  toolCallIds: string[];
}

export interface HistoryPolicyInput {
  messages: readonly ChatMessage[];
}

export interface HistoryPolicyResult {
  messages: readonly ChatMessage[];
  decisions: HistoryPolicyDecision[];
}

export interface HistoryPolicy {
  name: string;
  apply(input: HistoryPolicyInput): HistoryPolicyResult;
}

export const HistoryPolicyContext = createContext<HistoryPolicy>("ChatHistoryPolicy");

export function applyHistoryPolicy(
  policy: HistoryPolicy | undefined,
  context: ModelContext,
): { context: ModelContext; decisions: HistoryPolicyDecision[] } {
  if (!policy) {
    return { context, decisions: [] };
  }
  const result = policy.apply({ messages: context.messages });
  if (result.decisions.length === 0) {
    return { context, decisions: [] };
  }
  return { context: { ...context, messages: result.messages }, decisions: result.decisions };
}

interface Turn {
  messages: ChatMessage[];
  toolCallIds: string[];
}

function toolCallIdsOf(message: ChatMessage): string[] {
  if (message.role === "assistant") {
    return message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCall.id] : []));
  }
  return message.role === "tool" ? [message.toolCallId] : [];
}

function groupIntoTurns(messages: readonly ChatMessage[]): Turn[] {
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
  maxMessages: number;
}

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
        return { messages: [...messages], decisions: [] };
      }
      const turns = groupIntoTurns(conversational);
      const kept: Turn[] = [];
      let keptCount = 0;
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
        return { messages: [...messages], decisions: [] };
      }
      const decisions = dropped.map((turn) => ({
        action: "drop_turn" as const,
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
