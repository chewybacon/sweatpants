import { Box, useStdout } from "ink";
import type { TerminalChatClient, TerminalInteractionRuntime } from "../terminal/interaction.ts";
import { StatusBar } from "./StatusBar.tsx";
import { MessageList } from "./MessageList.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { InputBar } from "./InputBar.tsx";
import { useAgentChat } from "../hooks/use-agent-chat.ts";

export interface AppProps {
  readonly client: TerminalChatClient;
  readonly interaction: TerminalInteractionRuntime;
}

export function App({ client, interaction }: AppProps) {
  const { stdout } = useStdout();
  const { messages, busy, send, error } = useAgentChat(client);
  const width = stdout.columns || 80;
  const height = stdout.rows || 24;
  const messageListHeight = Math.max(height - 10, 5);
  const prompt = interaction.activePrompt;
  const submit = (value: string): void => {
    if (!prompt) {
      send(value);
    } else if (value === "/decline") {
      interaction.decline();
    } else if (value === "/cancel") {
      interaction.cancelActive();
    } else {
      interaction.respond(value);
    }
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexShrink={0}>
        <StatusBar />
      </Box>

      <Box flexGrow={1} flexDirection="row">
        <Box flexDirection="column" width="80%" borderStyle="single" borderColor="gray">
          <MessageList messages={messages} busy={busy} height={messageListHeight} />
        </Box>

        <Box width="20%" borderStyle="single" borderColor="gray">
          <Sidebar error={error} />
        </Box>
      </Box>

      <Box flexShrink={0}>
        <InputBar
          onSubmit={submit}
          disabled={busy && !prompt}
          placeholder={
            prompt ? `${prompt.message} (/decline or /cancel)` : "Ask about the codebase..."
          }
        />
      </Box>
    </Box>
  );
}
