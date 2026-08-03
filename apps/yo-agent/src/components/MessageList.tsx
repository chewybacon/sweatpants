import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage, ChatPart } from "@sweatpants/chat-client";
import type { TerminalPromptPart } from "../terminal/interaction.ts";
import { FrameRenderer } from "../pipeline/index.ts";
import { Scrollable } from "./Scrollable.tsx";

interface MessageListProps {
  readonly messages: readonly ChatMessage<TerminalPromptPart>[];
  readonly busy?: boolean;
  readonly height?: number;
}

function printable(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function PartView({ part }: { readonly part: ChatPart<TerminalPromptPart> }) {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.frame.blocks.length > 0 ? (
        <FrameRenderer frame={part.frame} />
      ) : (
        <Text wrap="wrap">{part.text}</Text>
      );
    case "tool-call": {
      const output = printable(part.output);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            [Tool: {part.name}] {part.state}
          </Text>
          {part.errorText && <Text color="red">{part.errorText}</Text>}
          {output && <Text color="gray">{output}</Text>}
          <PartList parts={part.parts} />
        </Box>
      );
    }
    case "message":
      return (
        <Box marginLeft={2}>
          <MessageView message={part.message} />
        </Box>
      );
    case "activity":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">
            [{part.activityType}] {part.state}
          </Text>
          <PartList parts={part.parts} />
        </Box>
      );
    case "elicit":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={part.state === "pending" ? "yellow" : "gray"}>
            [Input requested] {part.message} ({part.state})
          </Text>
          <PartList parts={part.parts} />
        </Box>
      );
    case "terminal-prompt":
      return (
        <Text color={part.state === "pending" ? "yellow" : "green"}>
          {part.state === "pending" ? ">" : "✓"} {part.message}
          {part.response ? ` — ${part.response}` : ""}
        </Text>
      );
  }
}

function PartList({ parts }: { readonly parts: readonly ChatPart<TerminalPromptPart>[] }) {
  return (
    <Box flexDirection="column">
      {parts.map((part) => (
        <PartView key={part.id} part={part} />
      ))}
    </Box>
  );
}

function MessageView({ message }: { readonly message: ChatMessage<TerminalPromptPart> }) {
  const label =
    message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : "System";
  const color = message.role === "user" ? "green" : message.role === "assistant" ? "cyan" : "gray";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}:
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <PartList parts={message.parts} />
      </Box>
    </Box>
  );
}

export function MessageList({ messages, busy = false, height = 20 }: MessageListProps) {
  if (messages.length === 0 && !busy) {
    return (
      <Box flexDirection="column" justifyContent="flex-end" flexGrow={1} padding={1}>
        <Text color="gray" dimColor>
          Welcome to yo-agent. Host, model, tools, transport, and UI are running in this process.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Scrollable height={height - 2} scrollToBottom={true} flexGrow={1} scrollbarThumbColor="cyan">
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
        {busy && (
          <Text color="cyan">
            <Spinner type="dots" /> Thinking...
          </Text>
        )}
      </Scrollable>
    </Box>
  );
}
