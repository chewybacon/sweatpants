import { activeWork } from "./activity.ts";
import { fetchWithAuthoringPolicy } from "./authoring.ts";
import { choicesPlugin, documentDisplayPlugin } from "./choices-plugin.tsx";
import { useRef, useState } from "react";
import { useChat } from "@sweatpants/react-chat";
import { Badge, Button, Card, Stack, TextArea } from "../design-system/primitives.tsx";
import { hasVisiblePart, Part } from "./tool-view.tsx";
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
  const {
    messages,
    status,
    sendMessage,
    stop,
    error,
    renderStatus,
    canSendMessage,
    authority,
    connectionStatus,
    history,
    loadOlder,
  } = useChat({
    api: "/api/chat",
    fetcher: fetchWithAuthoringPolicy,
    threadId,
    plugins: [askPlugin, choicesPlugin, documentDisplayPlugin],
    pipeline: "markdown",
  });
  const busy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const currentWork =
    (authority?.state === "running" || authority?.state === "parked") &&
    (connectionStatus === "connected" ||
      (authority?.state === "parked" && connectionStatus === "disconnected")) &&
    renderStatus === "ready" &&
    lastMessage?.role === "assistant"
      ? lastMessage.parts.flatMap((part) => activeWork(part))
      : [];
  const activityLabel = error
    ? "Something went wrong"
    : connectionStatus === "error"
      ? "Connection interrupted"
      : connectionStatus === "connecting"
        ? "Connecting…"
        : renderStatus === "loading" || !authority
          ? "Loading conversation…"
          : authority.state === "recovering"
            ? "Recovering workflow…"
            : authority.state === "deleted"
              ? "Conversation unavailable"
              : canSendMessage
                ? "Ready for a task"
                : currentWork.length === 1
                  ? currentWork[0].label
                  : currentWork.length > 1
                    ? `${currentWork.length} active activities`
                    : authority.state === "parked"
                      ? "Waiting for workflow to resume…"
                      : connectionStatus === "disconnected"
                        ? "Disconnected"
                        : "Working…";

  return (
    <div className="chat-app">
      {(error || commandError) && (
        <Card.Root className="error-card" tone="error" padding={4}>
          <p role="alert">{error?.message ?? commandError}</p>
        </Card.Root>
      )}

      <section className="conversation" aria-label="Conversation">
        {history.hasOlder && (
          <Button
            type="button"
            variant="outline"
            disabled={history.loadingOlder}
            onClick={() => void loadOlder()}
          >
            {history.loadingOlder ? "Loading earlier activity…" : "Load earlier activity"}
          </Button>
        )}
        {history.error && <p role="alert">{history.error.message}</p>}
        {messages.length === 0 && !busy && !history.hasOlder && canSendMessage && (
          <PromptExamples
            onSelect={(example) => {
              setPrompt(example);
              textarea.current?.focus();
            }}
          />
        )}
        {messages
          .filter((message) => message.parts.some(hasVisiblePart))
          .map((message) => (
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

      <aside className="workflow-activity" aria-label="Current activity">
        <p role="status" aria-live="polite">
          {activityLabel}
        </p>
        {currentWork.length > 0 && (
          <ul>
            {currentWork.map((work) => (
              <li key={work.id}>
                {work.path.length > 0 && (
                  <span className="activity-path">{work.path.join(" › ")}</span>
                )}
                <span>{work.label}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>

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
            <span className="composer-status">{activityLabel}</span>
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
