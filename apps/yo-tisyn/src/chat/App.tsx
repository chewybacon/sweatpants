import { useRef, useState } from "react";
import { useChat } from "@sweatpants/react-chat";
import { Badge, Button, Card, Stack, TextArea } from "../design-system/primitives.tsx";
import { Part } from "./tool-view.tsx";
import { askPlugin } from "./ask-plugin.tsx";
import { rememberThread } from "../threads/thread-index.ts";
import { PromptExamples } from "./prompt-examples.tsx";

export interface AppProps {
  initialThreadId: string;
}

export function App({ initialThreadId }: AppProps) {
  const [threadId] = useState(() => {
    rememberThread(initialThreadId);
    return initialThreadId;
  });
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
    <div className="chat-app">
      {(error || commandError) && (
        <Card.Root className="error-card" tone="error" padding={4}>
          <p role="alert">{error?.message ?? commandError}</p>
        </Card.Root>
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
          <Card.Root
            key={message.id}
            className="message-card"
            tone={message.role === "user" ? "secondary" : "default"}
            padding={5}
          >
            <Stack direction="horizontal" gap={2} align="center">
              <Badge tone={message.role === "user" ? "secondary" : "neutral"}>
                {message.role === "user" ? "You" : "Assistant"}
              </Badge>
              <span className="message-status">{message.role === "user" ? "sent" : ""}</span>
            </Stack>
            <div className="message-parts">
              {message.parts.map((part) => (
                <Part key={part.id} part={part} />
              ))}
            </div>
          </Card.Root>
        ))}
      </section>

      <Card.Root className="composer-card" tone="raised" padding={5}>
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
            label="Describe a workflow"
            rows={4}
            value={prompt}
            placeholder="Choose an example, or describe your own workflow…"
            onValueChange={setPrompt}
            disabled={!canSendMessage}
          />
          <Stack direction="horizontal" gap={2} align="center" wrap className="composer-actions">
            <Button
              type="submit"
              disabled={!prompt.trim() || !canSendMessage || renderStatus !== "ready"}
            >
              Send task
            </Button>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              disabled={!busy}
              onClick={() =>
                void stop().catch((failure: unknown) => setCommandError(String(failure)))
              }
            >
              Stop
            </Button>
            <span className="composer-status">
              {busy ? "Working…" : canSendMessage ? "Ready for a task" : "Waiting for your reply"}
            </span>
          </Stack>
        </form>
      </Card.Root>

      <Stack className="thread-meta" direction="horizontal" justify="between" gap={3} wrap>
        <span>
          Thread <code>{threadId}</code>
        </span>
        <Button href="/playground" variant="outline" size="sm">
          New thread ＋
        </Button>
      </Stack>
    </div>
  );
}
