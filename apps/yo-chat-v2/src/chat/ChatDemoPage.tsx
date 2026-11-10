import type { ComponentProps } from "react";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { ToolUIProvider, ToolOutlet } from "@sweatpan.tsx/chat";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import type { ToolUIPlugin } from "@sweatpan.tsx/chat";
import type { createDemoClient } from "./client.ts";

export interface ChatDemoPageProps {
  fetch?: typeof fetch;
  createClient(send?: typeof fetch): ReturnType<typeof createDemoClient>;
  plugins: readonly ToolUIPlugin[];
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyDescription: string;
  placeholder: string;
  waitingLabel: string;
  toolLabel: string;
  showToolLabel?: boolean;
  workingLabel: string;
  completedLabel: string;
  suggestions: readonly { label: string; prompt: string }[];
}

const styles = stylex.create({
  centered: { marginInline: "auto" },
  aligned: { paddingInline: 0 },
  tool: { paddingInline: 0, paddingBlock: 0 },
});

function ParkedLayout({ children, composer }: ComponentProps<typeof ChatLayout>) {
  return (
    <VStack gap={3}>
      {children}
      {composer}
    </VStack>
  );
}

/** Keep the existing site frame; compose the Astryx ai-chat transcript/composer inside it. */
export function ChatDemoPage({ fetch: send, createClient, plugins, ...copy }: ChatDemoPageProps) {
  const [client] = useState(() => createClient(send));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    void client.connect();
    return () => client.disconnect();
  }, [client]);
  const turns = state.view?.turns ?? [];
  const waiting = turns.some((turn) =>
    turn.parts.some(
      (part) =>
        part.type === "tool" && part.questions.some((question) => question.state === "open"),
    ),
  );
  const Layout = waiting ? ParkedLayout : ChatLayout;
  const running = turns.at(-1)?.status === "running";
  const disabled = !state.loaded || state.busy || !!state.pending || running;
  function submit(prompt: string) {
    setDraft("");
    void client.submit(prompt);
  }
  return (
    <VStack gap={4} width="100%" maxWidth="calc(var(--spacing-10) * 20)" xstyle={styles.centered}>
      <VStack gap={2} paddingInline={4}>
        <HStack justify="between" align="center" wrap="wrap" gap={3}>
          <Heading level={1}>{copy.title}</Heading>
          <Button
            label="New conversation"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft("");
              void client.select();
            }}
            isDisabled={state.busy || !state.loaded}
          />
        </HStack>
        <Text color="secondary">{copy.subtitle}</Text>
      </VStack>
      {state.threads.length > 1 && (
        <HStack as="nav" aria-label="Conversations" gap={2} wrap="wrap">
          {state.threads.map((thread) => (
            <Button
              key={thread.thread}
              label={thread.title}
              variant={thread.thread === state.current ? "primary" : "ghost"}
              isDisabled={state.busy}
              onClick={() => {
                setDraft("");
                void client.select(thread.thread);
              }}
            />
          ))}
        </HStack>
      )}
      <ToolUIProvider source={client.presentation} plugins={plugins}>
        <Layout
          density="compact"
          scrollButton={null}
          composer={
            <VStack gap={3}>
              {state.error && <Text role="alert">{state.error}</Text>}
              <HStack gap={2}>
                {state.pending && (
                  <Button
                    label="Retry same command"
                    isDisabled={state.busy}
                    onClick={() => void client.retry()}
                  />
                )}
                {running && !waiting && !state.pending && (
                  <Button
                    label="Continue conversation"
                    isDisabled={state.busy}
                    onClick={() => void client.resume()}
                  />
                )}
                {state.error && (
                  <Button
                    label="Check status"
                    isDisabled={state.busy}
                    onClick={() => void client.refresh()}
                  />
                )}
              </HStack>
              {!waiting && (
                <ChatComposer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submit}
                  isDisabled={disabled}
                  placeholder={copy.placeholder}
                />
              )}
            </VStack>
          }
        >
          {!turns.length && !state.pending && (
            <VStack gap={4} paddingBlock={8}>
              <Heading level={2}>{copy.emptyTitle}</Heading>
              <Text color="secondary">{copy.emptyDescription}</Text>
              <HStack gap={2} wrap="wrap">
                {copy.suggestions.map((suggestion) => (
                  <Button
                    key={suggestion.label}
                    label={suggestion.label}
                    isDisabled={disabled}
                    onClick={() => submit(suggestion.prompt)}
                  />
                ))}
              </HStack>
            </VStack>
          )}
          <ChatMessageList xstyle={styles.aligned}>
            {turns.map((turn) => (
              <Fragment key={turn.execution}>
                <ChatMessage sender="user">
                  <ChatMessageBubble>{turn.prompt}</ChatMessageBubble>
                </ChatMessage>
                {turn.parts.map((part) => (
                  <ChatMessage key={part.id} sender="assistant">
                    <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.tool}>
                      {part.type === "text" ? (
                        <Markdown>{part.text}</Markdown>
                      ) : (
                        <Card padding={4}>
                          <VStack gap={3}>
                            {copy.showToolLabel !== false && (
                              <Text type="label">{copy.toolLabel}</Text>
                            )}
                            {!part.questions.length && (
                              <Text color="secondary">{copy.workingLabel}</Text>
                            )}
                            {part.questions.map((question) => (
                              <ToolOutlet key={question.id} question={question.id} />
                            ))}
                            {part.questions.some((question) => question.state === "open") && (
                              <Text type="supporting">{copy.waitingLabel}</Text>
                            )}
                            {part.status === "completed" && (
                              <Text type="supporting" color="secondary">
                                {copy.completedLabel}
                                {part.result ? `: ${part.result}` : ""}
                              </Text>
                            )}
                          </VStack>
                        </Card>
                      )}
                    </ChatMessageBubble>
                  </ChatMessage>
                ))}
              </Fragment>
            ))}
            {state.pending?.type === "message" && state.view?.latest === state.pending.after && (
              <ChatMessage sender="user">
                <ChatMessageBubble>{state.pending.prompt}</ChatMessageBubble>
              </ChatMessage>
            )}
            {state.busy && (
              <ChatMessage sender="assistant">
                <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.tool}>
                  {state.text ? (
                    <Markdown>{state.text}</Markdown>
                  ) : (
                    <Text color="secondary" role="status">
                      Thinking…
                    </Text>
                  )}
                </ChatMessageBubble>
              </ChatMessage>
            )}
          </ChatMessageList>
        </Layout>
      </ToolUIProvider>
    </VStack>
  );
}
