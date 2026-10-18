import { useMemo, useState } from "react";
import { useChat, type ReactChatUIMessage, type ReactChatUIPart } from "@sweatpants/react-chat";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
  ChatComposer,
  ChatMessage as AstryxChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";

import { studioView } from "./config.ts";
import { playTttPlugin } from "./capabilities/tic-tac-toe-plugin.ts";
import { getOrCreateConversationId, replaceConversationId } from "./session-id.ts";

const CHAT_PANEL_HEIGHT = 560;
const TRANSCRIPT_TARGET_MAX_LENGTH = 96;

function compactTarget(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }
  return text.length > TRANSCRIPT_TARGET_MAX_LENGTH
    ? `${text.slice(0, TRANSCRIPT_TARGET_MAX_LENGTH)}…`
    : text;
}

function ToolCallGroup({ part }: { part: Extract<ReactChatUIPart, { type: "tool-call" }> }) {
  const item: ChatToolCallItem = {
    key: part.id,
    name: part.name,
    status:
      part.state === "output-error"
        ? "error"
        : part.state === "output-available"
          ? "complete"
          : "running",
    target: compactTarget(part.rawInput ?? part.input),
    resultDetail:
      part.output !== undefined ? (
        <CodeBlock code={JSON.stringify(part.output, null, 2)} language="json" maxHeight="40vh" />
      ) : undefined,
    errorMessage: part.errorText ? part.errorText : undefined,
  };
  return (
    <>
      <ChatToolCalls calls={[item]} />
      {part.parts.map((child) => (
        <Part key={child.id} part={child} />
      ))}
    </>
  );
}

function Part({
  part,
  role = "assistant",
}: {
  part: ReactChatUIPart;
  role?: ReactChatUIMessage["role"];
}) {
  switch (part.type) {
    case "text":
      return (
        <ChatMessageBubble variant={role === "user" ? "filled" : "ghost"}>
          <span className="chat-html-content" dangerouslySetInnerHTML={{ __html: part.rendered }} />
        </ChatMessageBubble>
      );
    case "reasoning":
      return (
        <ChatMessageBubble variant="ghost">
          <Collapsible trigger="Reasoning" defaultIsOpen={false}>
            <span
              className="chat-html-content"
              dangerouslySetInnerHTML={{ __html: part.rendered }}
            />
          </Collapsible>
        </ChatMessageBubble>
      );
    case "tool-call":
      return <ToolCallGroup part={part} />;
    case "message":
      return <Message message={part.message} />;
    case "activity":
    case "elicit":
      return part.parts.map((child) => <Part key={child.id} part={child} />);
    case "render":
      return <>{part.node}</>;
    default:
      return null;
  }
}

function Message({ message }: { message: ReactChatUIMessage }) {
  return (
    <AstryxChatMessage sender={message.role}>
      {message.parts.map((part) => (
        <Part key={part.id} part={part} role={message.role} />
      ))}
    </AstryxChatMessage>
  );
}

function DurableChat({ conversationId }: { conversationId: string }) {
  const [task, setTask] = useState("Inspect the workspace and report its current version");
  const { messages, status, sendMessage, stop, error, renderStatus } = useChat({
    api: "/api/chat",
    threadId: conversationId,
    pipeline: "markdown",
    plugins: [playTttPlugin],
  });
  const busy = status === "submitted" || status === "streaming";
  const renderReady = renderStatus === "ready";

  function submit(value: string) {
    if (value.trim().length === 0 || busy) {
      return;
    }
    sendMessage(value.trim());
    setTask("");
  }

  return (
    <Card padding={0} height={CHAT_PANEL_HEIGHT}>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider>
            <HStack padding={4} justify="between" vAlign="center">
              <VStack gap={0}>
                <Text type="label" color="secondary">
                  Durable coding harness
                </Text>
                <Text type="supporting" color="secondary">
                  conversation {conversationId.slice(0, 8)}
                </Text>
              </VStack>
              <Badge
                variant={renderReady ? "success" : "neutral"}
                label={renderReady ? "Handler ready" : "Loading"}
              />
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={4}>
            <ChatMessageList
              isStreaming={busy}
              emptyState={
                <EmptyState
                  isCompact
                  title="No messages yet"
                  description="Send a task to the journal-native coding harness."
                />
              }
            >
              {messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
            </ChatMessageList>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <ChatComposer
              value={task}
              onChange={setTask}
              onSubmit={submit}
              isStopShown={busy}
              onStop={stop}
              isDisabled={!renderReady}
              placeholder="Send a task to the journal-native coding harness…"
              status={error ? { type: "error" as const, message: error.message } : undefined}
            />
          </LayoutFooter>
        }
      />
    </Card>
  );
}

export function App() {
  const [conversationId, setConversationId] = useState(() =>
    getOrCreateConversationId(window.localStorage),
  );
  const toolNames = useMemo(() => [...studioView.capabilityNames], []);
  const placement =
    __YO_STUDIO_WORKSPACE_PLACEMENT__ === "aws" ? "AWS Lambda MicroVM" : "Local Effection runtime";
  const runtimeLabel =
    __YO_STUDIO_WORKSPACE_PLACEMENT__ === "aws"
      ? `Node ${studioView.sandbox.image.node} · ARM64`
      : "Node · loopback connector";

  function newSession() {
    setConversationId(replaceConversationId(window.localStorage));
  }

  return (
    <AppShell
      contentPadding={4}
      height="auto"
      topNav={
        <TopNav
          heading={
            <TopNavHeading superheading="Sweatpants reference assembly" heading="yo-studio" />
          }
          endContent={<Button label="New session" variant="secondary" onClick={newSession} />}
        />
      }
    >
      <VStack gap={6}>
        <Text type="body" color="secondary">
          Author processless durable programs once, then project them through React, HTTP, and MCP
          onto replaceable workspace compute.
        </Text>

        <DurableChat key={conversationId} conversationId={conversationId} />

        <Grid columns={{ minWidth: 320 }} gap={4}>
          <Card>
            <VStack gap={4}>
              <VStack gap={1}>
                <Text type="label" color="secondary">
                  Durable program
                </Text>
                <Heading level={3}>{studioView.program.id}</Heading>
              </VStack>
              <List hasDividers density="compact">
                <ListItem
                  label="Version"
                  endContent={<Text type="body">{studioView.program.version}</Text>}
                />
                <ListItem
                  label="Model loop"
                  endContent={<Text type="body">{studioView.program.modelLoop}</Text>}
                />
                <ListItem
                  label="Model provider"
                  endContent={<Text type="body">{studioView.modelProvider.model}</Text>}
                />
                <ListItem
                  label="Sampling authority"
                  endContent={<Text type="body">{studioView.modelSampling.ownership}</Text>}
                />
                <ListItem
                  label="Iterations"
                  endContent={<Text type="body">{studioView.program.maxIterations}</Text>}
                />
              </List>
              <Divider />
              <VStack gap={2}>
                <Text type="label" color="secondary">
                  Closed capability map
                </Text>
                <HStack gap={2} wrap="wrap">
                  {toolNames.map((name) => (
                    <Token key={name} label={name} />
                  ))}
                </HStack>
              </VStack>
            </VStack>
          </Card>

          <Card>
            <VStack gap={4}>
              <VStack gap={1}>
                <Text type="label" color="secondary">
                  Workspace placement
                </Text>
                <Heading level={3}>{placement}</Heading>
              </VStack>
              <List hasDividers density="compact">
                <ListItem label="Runtime" endContent={<Text type="body">{runtimeLabel}</Text>} />
                <ListItem
                  label="Persistence"
                  endContent={
                    <Text type="body">{studioView.sandbox.capabilities.workspacePersistence}</Text>
                  }
                />
                <ListItem
                  label="Network"
                  endContent={
                    <Badge variant="neutral" label={studioView.workspace.policy.network} />
                  }
                />
              </List>
              <Divider />
              <VStack gap={2}>
                <Text type="label" color="secondary">
                  Named scripts
                </Text>
                <CodeBlock
                  code={JSON.stringify(studioView.workspace.scripts, null, 2)}
                  language="json"
                  size="sm"
                />
              </VStack>
            </VStack>
          </Card>
        </Grid>

        <Card variant="muted">
          <VStack gap={3} hAlign="center">
            <Text type="label" color="secondary">
              One program, multiple projections
            </Text>
            <HStack gap={2} wrap="wrap" justify="center">
              <Token label="React useChat" />
              <Token label="Headless HTTP" />
              <Token label="MCP" />
            </HStack>
            <Text type="body" weight="semibold">
              Durable chat handler + workflow host
            </Text>
            <Token label="MicroVM workspace" color="blue" />
          </VStack>
        </Card>
      </VStack>
    </AppShell>
  );
}
