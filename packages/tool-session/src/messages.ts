import {
  decodeChatMessage,
  type ChatAssistantMessage,
  type ChatContent,
  type ChatContentPart,
  type ChatMessage,
  type ChatMessagePart,
  type ChatToolCall,
  type ChatToolResultMessage,
  type ChatUserMessage,
} from "@sweatpants/chat-contract";
import { UnsupportedModelCapabilityError } from "@sweatpants/model-provider";
import type { McpContentBlock, McpMessage, McpToolResultContent } from "./mcp/protocol/types.ts";

function unsupported(path: string, modality: string, message: string): never {
  throw new UnsupportedModelCapabilityError(path, modality, message);
}

function decodeMcpContentParts(
  blocks: readonly McpContentBlock[],
  path: string,
): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image":
        parts.push({
          type: "image",
          source: { type: "data", value: block.data, mimeType: block.mimeType },
          metadata: null,
        });
        break;
      case "audio":
      case "resource":
        unsupported(
          `${path}[${index}]`,
          block.type,
          `MCP ${block.type} content has no canonical Chat representation`,
        );
      case "tool_use":
      case "tool_result":
        unsupported(
          `${path}[${index}]`,
          block.type,
          `${block.type} content must be decoded as a message-level MCP value`,
        );
    }
  }
  return parts;
}

function resolveToolName(
  result: { toolCallId: string },
  toolNames: ReadonlyMap<string, string>,
  path: string,
): string {
  const name = toolNames.get(result.toolCallId);
  if (!name) {
    throw new Error(
      `${path}: tool result "${result.toolCallId}" has no preceding tool call identity`,
    );
  }
  return name;
}

function mcpToolResult(
  result: McpToolResultContent,
  toolNames: ReadonlyMap<string, string>,
  path: string,
): ChatMessage {
  return decodeChatMessage(
    {
      role: "tool",
      toolCallId: result.toolUseId,
      name: resolveToolName({ toolCallId: result.toolUseId }, toolNames, path),
      content: decodeMcpContentParts(result.content, `${path}.content`),
      isError: result.isError === true,
    },
    path,
  );
}

function assistantFromMcp(blocks: readonly McpContentBlock[], path: string): ChatMessage {
  const parts: ChatMessagePart[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "tool_use") {
      const call: ChatToolCall = {
        id: block.id,
        name: block.name,
        input: block.input,
        thoughtSignature: null,
      };
      parts.push({ type: "tool-call", toolCall: call });
    } else if (block.type === "tool_result") {
      unsupported(
        `${path}[${index}]`,
        block.type,
        "MCP tool results cannot appear in an assistant message",
      );
    } else {
      parts.push(...decodeMcpContentParts([block], `${path}[${index}]`));
    }
  }
  return decodeChatMessage({ role: "assistant", content: parts }, path);
}

/** Decode MCP sampling history once into canonical Chat messages. */
export function mcpMessagesToChatMessages(messages: readonly McpMessage[]): ChatMessage[] {
  const toolNames = new Map<string, string>();
  const output: ChatMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const path = `$.messages[${index}]`;
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    for (const call of toolUses) toolNames.set(call.id, call.name);
    const toolResults = blocks.filter((block) => block.type === "tool_result");

    if (message.role === "assistant") {
      if (toolResults.length > 0) {
        unsupported(`${path}.content`, "tool_result", "MCP tool results require a user message");
      }
      output.push(assistantFromMcp(blocks, path));
      continue;
    }

    if (toolUses.length > 0) {
      unsupported(`${path}.content`, "tool_use", "user MCP messages cannot contain tool calls");
    }
    if (toolResults.length > 0) {
      if (toolResults.length !== blocks.length) {
        unsupported(
          `${path}.content`,
          "mixed-content",
          "MCP tool result messages cannot mix tool results with ordinary content",
        );
      }
      output.push(
        ...toolResults.map((result, resultIndex) =>
          mcpToolResult(result, toolNames, `${path}.content[${resultIndex}]`),
        ),
      );
      continue;
    }

    output.push(
      decodeChatMessage(
        { role: "user", content: decodeMcpContentParts(blocks, `${path}.content`) },
        path,
      ),
    );
  }

  return output;
}

function mcpContentFromChatPart(part: ChatContentPart, path: string): McpContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      if (part.source.type !== "data") {
        return unsupported(path, "image-url", "MCP image content requires an inline data source");
      }
      if (part.metadata !== null) {
        return unsupported(path, "image-metadata", "MCP cannot represent image metadata");
      }
      return { type: "image", data: part.source.value, mimeType: part.source.mimeType };
    case "audio":
      if (part.source.type !== "data") {
        return unsupported(path, "audio-url", "MCP audio content requires an inline data source");
      }
      if (part.metadata !== null) {
        return unsupported(path, "audio-metadata", "MCP cannot represent audio metadata");
      }
      return { type: "audio", data: part.source.value, mimeType: part.source.mimeType };
    case "video":
    case "document":
      return unsupported(path, part.type, `MCP has no ${part.type} content representation`);
  }
}

function mcpContentFromChatContent(content: ChatContent, path: string): McpContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part, index) => mcpContentFromChatPart(part, `${path}[${index}]`));
}

function mcpAssistantMessage(message: ChatAssistantMessage, path: string): McpMessage {
  const content: McpContentBlock[] = [];
  for (const [index, part] of message.content.entries()) {
    if (part.type === "tool-call") {
      content.push({
        type: "tool_use",
        id: part.toolCall.id,
        name: part.toolCall.name,
        input: part.toolCall.input,
      });
    } else if (part.type === "reasoning") {
      return unsupported(path, "reasoning", "MCP sampling history has no reasoning representation");
    } else {
      content.push(mcpContentFromChatPart(part, `${path}.content[${index}]`));
    }
  }
  return { role: "assistant", content };
}

function mcpToolResultMessage(message: ChatToolResultMessage, path: string): McpMessage {
  return {
    role: "user",
    content: {
      type: "tool_result",
      toolUseId: message.toolCallId,
      content: mcpContentFromChatContent(message.content, `${path}.content`),
      isError: message.isError,
    },
  };
}

function mcpUserMessage(message: ChatUserMessage, path: string): McpMessage {
  return {
    role: "user",
    content: mcpContentFromChatContent(message.content, `${path}.content`),
  };
}

/** Encode canonical Chat messages only at the MCP protocol boundary. */
export function chatMessagesToMcpMessages(messages: readonly ChatMessage[]): McpMessage[] {
  return messages.map((message, index) => {
    const path = `$.messages[${index}]`;
    switch (message.role) {
      case "user":
        return mcpUserMessage(message, path);
      case "assistant":
        return mcpAssistantMessage(message, path);
      case "tool":
        return mcpToolResultMessage(message, path);
      case "system":
      case "developer":
        return unsupported(
          path,
          message.role,
          `MCP sampling cannot encode ${message.role} messages`,
        );
    }
  });
}
