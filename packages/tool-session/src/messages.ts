import type {
  ContentBlock as ModelContentBlock,
  Message as ModelMessage,
  ToolCall,
} from "@sweatpants/model-provider";
import type { McpContentBlock, McpMessage, McpToolResultContent } from "./mcp/protocol/types.ts";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolCallMessage {
  role: "assistant";
  content: string;
  toolCalls: [ToolCall, ...ToolCall[]];
}

export interface ToolResultMessage {
  role: "tool";
  content: string;
  toolCallId: string;
  /** Producer-owned when available; otherwise resolved from preceding calls. */
  toolName?: string;
  isError: boolean;
}

export type ExtendedMessage = Message | McpMessage | ToolCallMessage | ToolResultMessage;

export function isToolCallMessage(message: ExtendedMessage): message is ToolCallMessage {
  return "toolCalls" in message;
}

export function isToolResultMessage(message: ExtendedMessage): message is ToolResultMessage {
  return message.role === "tool";
}

export function isMcpMessage(message: ExtendedMessage): message is McpMessage {
  return typeof message.content !== "string";
}

function textFromBlocks(blocks: readonly McpContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function modelContentFromBlocks(blocks: readonly McpContentBlock[]): ModelContentBlock[] {
  const content: ModelContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        content.push(block);
        break;
      case "image":
        content.push(block);
        break;
    }
  }
  return content;
}

function resolveToolName(
  result: { toolCallId: string; toolName?: string },
  toolNames: ReadonlyMap<string, string>,
): string {
  const name = result.toolName ?? toolNames.get(result.toolCallId);
  if (!name) {
    throw new Error(`Tool result "${result.toolCallId}" has no preceding tool call identity`);
  }
  return name;
}

function modelResult(
  result: { toolCallId: string; toolName?: string; content: string; isError: boolean },
  toolNames: ReadonlyMap<string, string>,
): ModelMessage {
  return {
    role: "toolResult",
    toolCallId: result.toolCallId,
    toolName: resolveToolName(result, toolNames),
    content: [{ type: "text", text: result.content }],
    isError: result.isError,
  };
}

function mcpResult(
  result: McpToolResultContent,
  toolNames: ReadonlyMap<string, string>,
): ModelMessage {
  return {
    role: "toolResult",
    toolCallId: result.toolUseId,
    toolName: resolveToolName({ toolCallId: result.toolUseId }, toolNames),
    content: modelContentFromBlocks(result.content),
    isError: result.isError === true,
  };
}

/**
 * Converts Tool Session sampling history directly to the neutral model contract.
 * Call/result identity is resolved over the complete causal sequence; no Chat
 * Core message, synthetic message id, or empty tool name is introduced.
 */
export function toModelMessages(messages: readonly ExtendedMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const output: ModelMessage[] = [];

  for (const message of messages) {
    if (isToolCallMessage(message)) {
      for (const call of message.toolCalls) {
        toolNames.set(call.id, call.function.name);
      }
      output.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({ type: "toolCall" as const, toolCall })),
        ],
      });
      continue;
    }

    if (isToolResultMessage(message)) {
      output.push(modelResult(message, toolNames));
      continue;
    }

    if (!isMcpMessage(message)) {
      switch (message.role) {
        case "assistant":
          output.push({
            role: "assistant",
            content: message.content ? [{ type: "text" as const, text: message.content }] : [],
          });
          break;
        case "system":
          output.push({ role: "system", content: message.content });
          break;
        case "user":
          output.push({ role: "user", content: message.content });
          break;
      }
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    for (const call of toolUses) {
      toolNames.set(call.id, call.name);
    }
    if (toolUses.length > 0) {
      output.push({
        role: "assistant",
        content: [
          ...modelContentFromBlocks(blocks),
          ...toolUses.map((call) => ({
            type: "toolCall" as const,
            toolCall: {
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.input },
            },
          })),
        ],
      });
    } else {
      const toolResults = blocks.filter((block) => block.type === "tool_result");
      if (toolResults.length > 0) {
        output.push(...toolResults.map((result) => mcpResult(result, toolNames)));
      } else {
        const content = modelContentFromBlocks(blocks);
        output.push(
          message.role === "assistant"
            ? { role: "assistant", content }
            : { role: "user", content: content.length > 0 ? content : textFromBlocks(blocks) },
        );
      }
    }
  }

  return output;
}
