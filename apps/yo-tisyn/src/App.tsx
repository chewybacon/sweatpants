import { useRef, useState } from "react";
import { Badge, Button, Card, Heading, HStack, TextArea, Theme, VStack } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { useChat } from "@sweatpants/react-chat";
import { Part } from "./tool-view.tsx";
import { askPlugin } from "./ask-plugin.tsx";
import { PromptExamples } from "./prompt-examples.tsx";
import "./style.css";

export interface AppProps {
  initialThreadId?: string;
}

function rememberThread(id: string) {
  if (typeof window === "undefined") {
    return;
  }
  const recent = JSON.parse(localStorage.getItem("yo-tisyn.threads") ?? "[]") as string[];
  localStorage.setItem(
    "yo-tisyn.threads",
    JSON.stringify([id, ...recent.filter((threadId) => threadId !== id)].slice(0, 12)),
  );
}

function resolveThreadId(initialThreadId?: string) {
  if (typeof window === "undefined") {
    return initialThreadId ?? "server-thread";
  }
  const existing = initialThreadId ?? localStorage.getItem("yo-tisyn.thread");
  const id = existing ?? crypto.randomUUID();
  localStorage.setItem("yo-tisyn.thread", id);
  rememberThread(id);
  return id;
}

export function App({ initialThreadId }: AppProps) {
  const [threadId] = useState(() => resolveThreadId(initialThreadId));
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const { messages, status, sendMessage, stop, error, renderStatus, canSendMessage } = useChat({
    api: "/api/chat",
    threadId,
    plugins: [askPlugin],
    pipeline: "markdown",
  });
  const busy = status === "submitted" || status === "streaming";

  return (
    <Theme theme={neutralTheme}>
      <div className="chat-app">
        <Card className="hero-card" variant="teal" padding={6}>
          <HStack hAlign="between" vAlign="center" gap={4} wrap="wrap">
            <VStack gap={2}>
              <HStack gap={2} vAlign="center">
                <Badge label="EXPERIMENTAL" variant="teal" />
                <span className="eyebrow">Durable DSL playground</span>
              </HStack>
              <Heading level={1} type="display-1">
                yo-tisyn
              </Heading>
              <p className="hero-copy">
                Ask a model to author one typed Tisyn program. Sweatpants runs it durably, parks for
                replies, and recovers it when compute disappears.
              </p>
            </VStack>
            <VStack gap={2} className="hero-actions">
              <a className="astryx-link" href="/explain/quickjs">
                How QuickJS fits →
              </a>
              <a className="astryx-link" href="/threads">
                Browse threads →
              </a>
            </VStack>
          </HStack>
        </Card>

        {(error || commandError) && (
          <Card className="error-card" variant="red" padding={3}>
            <p role="alert">{error?.message ?? commandError}</p>
          </Card>
        )}

        <section className="conversation" aria-label="Conversation">
          {messages.length === 0 && !busy && (
            <PromptExamples
              onSelect={(example) => {
                setPrompt(example);
                textarea.current?.focus();
              }}
            />
          )}
          {messages.map((message) => (
            <Card
              key={message.id}
              className="message-card"
              variant={message.role === "user" ? "blue" : "default"}
              padding={4}
            >
              <HStack gap={2} vAlign="center">
                <Badge
                  label={message.role === "user" ? "YOU" : "ASSISTANT"}
                  variant={message.role === "user" ? "blue" : "neutral"}
                />
                <span className="message-status">
                  {message.role === "assistant" ? status : "sent"}
                </span>
              </HStack>
              <div className="message-parts">
                {message.parts.map((part) => (
                  <Part key={part.id} part={part} />
                ))}
              </div>
            </Card>
          ))}
        </section>

        <Card className="composer-card" padding={4}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim() && canSendMessage) {
                setCommandError(null);
                rememberThread(threadId);
                void sendMessage(prompt).catch((failure: unknown) =>
                  setCommandError(String(failure)),
                );
                setPrompt("");
              }
            }}
          >
            <TextArea
              ref={textarea}
              label="Task"
              rows={4}
              value={prompt}
              placeholder="Choose an example, or describe your own workflow…"
              onChange={setPrompt}
              isDisabled={!canSendMessage}
            />
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Button
                label="Send task"
                type="submit"
                variant="primary"
                isDisabled={!prompt.trim() || !canSendMessage || renderStatus !== "ready"}
              />
              <Button
                label="Stop"
                type="button"
                variant="secondary"
                isDisabled={!busy}
                onClick={() =>
                  void stop().catch((failure: unknown) => setCommandError(String(failure)))
                }
              />
              <span className="composer-status">
                {status} · renderer {renderStatus}
              </span>
            </HStack>
          </form>
        </Card>

        <HStack className="thread-meta" hAlign="between" gap={3} wrap="wrap">
          <span>
            Thread <code>{threadId}</code>
          </span>
          <Button
            label="Start new conversation"
            variant="ghost"
            size="sm"
            onClick={() => {
              localStorage.removeItem("yo-tisyn.thread");
              location.href = "/playground";
            }}
          />
        </HStack>
      </div>
    </Theme>
  );
}
