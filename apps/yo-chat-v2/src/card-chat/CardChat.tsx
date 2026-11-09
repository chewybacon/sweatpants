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
import { cardUI } from "../cards/card-ui.tsx";
import { createCardChatClient } from "./client.ts";

const plugins = [cardUI];

/** Keep the existing site frame; compose the Astryx ai-chat transcript/composer inside it. */
export function CardChat({ fetch: send }: { fetch?: typeof fetch }) {
  const [client] = useState(() => createCardChatClient(send));
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
  const running = turns.at(-1)?.status === "running";
  const disabled = !state.loaded || state.busy || !!state.pending || running;
  function submit(prompt: string) {
    setDraft("");
    void client.submit(prompt);
  }
  return (
    <VStack gap={6}>
      <HStack justify="between" align="center" wrap="wrap" gap={4}>
        <VStack gap={2}>
          <Heading level={1}>Card Picker</Heading>
          <Text color="secondary">A conversation with a little magic in the middle.</Text>
        </VStack>
        <Button
          label="New conversation"
          onClick={() => {
            setDraft("");
            void client.select();
          }}
          isDisabled={state.busy || !state.loaded}
        />
      </HStack>
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
        <ChatLayout
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
              {waiting && <Text color="secondary">Choose a card above to continue.</Text>}
              <ChatComposer
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                isDisabled={disabled}
                placeholder="Ask me to pick a card…"
              />
            </VStack>
          }
        >
          {!turns.length && !state.pending && (
            <VStack gap={4} paddingBlock={8}>
              <Heading level={2}>What will you draw?</Heading>
              <Text color="secondary">
                Ask for a few cards, choose your favorite, and keep the conversation going.
              </Text>
              <HStack gap={2} wrap="wrap">
                <Button
                  label="Pick a card"
                  isDisabled={disabled}
                  onClick={() => submit("Pick a card for me")}
                />
                <Button
                  label="Card game"
                  isDisabled={disabled}
                  onClick={() => submit("I want to play a card game")}
                />
              </HStack>
            </VStack>
          )}
          <ChatMessageList>
            {turns.map((turn) => (
              <Fragment key={turn.execution}>
                <ChatMessage sender="user">
                  <ChatMessageBubble>{turn.prompt}</ChatMessageBubble>
                </ChatMessage>
                {turn.parts.map((part) => (
                  <ChatMessage key={part.id} sender="assistant">
                    <ChatMessageBubble variant="ghost">
                      {part.type === "text" ? (
                        <Markdown>{part.text}</Markdown>
                      ) : (
                        <Card padding={4}>
                          <VStack gap={3}>
                            <Text type="label">Pick card</Text>
                            {!part.questions.length && (
                              <Text color="secondary">Drawing cards…</Text>
                            )}
                            {part.questions.map((question) => (
                              <ToolOutlet key={question.id} question={question.id} />
                            ))}
                            {part.status === "completed" && (
                              <Text type="supporting" color="secondary">
                                Selection recorded
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
                <ChatMessageBubble variant="ghost">
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
        </ChatLayout>
      </ToolUIProvider>
    </VStack>
  );
}
