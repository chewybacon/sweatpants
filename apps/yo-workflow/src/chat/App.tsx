import { workflowLanguage, type WorkflowLanguage } from "../workflow/language.ts";
import { CancelWorkflow, CurrentWorkflowActivity } from "./workflow-activity.tsx";
import { activeWork } from "./activity.ts";
import { ReplyFocusProvider } from "./reply-focus.tsx";
import { fetchWithAuthoringPolicy } from "./authoring.ts";
import { choicesPlugin, documentDisplayPlugin } from "./choices-plugin.tsx";
import { useEffect, useRef, useState } from "react";
import { rememberThreadSummary, summarizeThread } from "../threads/thread-summary.ts";
import { useChat } from "@sweatpants/react-chat";
import { Badge, Button, Card, Stack, TextArea } from "../design-system/primitives.tsx";
import { hasVisiblePart, Part } from "./tool-view.tsx";
import { fuelPlugin } from "./fuel-plugin.tsx";
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
  const [language, setLanguage] = useState<WorkflowLanguage>(() =>
    workflowLanguage(localStorage.getItem(`workflow-language:${initialThreadId}`)),
  );
  const selectedLanguage = useRef(language);
  selectedLanguage.current = language;
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const {
    messages,
    status,
    sendMessage,
    stop,
    reconnect,
    clearError,
    error,
    renderStatus,
    canSendMessage,
    authority,
    connectionStatus,
    history,
    loadOlder,
  } = useChat({
    api: "/api/chat",
    fetcher: (input, init) => fetchWithAuthoringPolicy(input, init, selectedLanguage.current),
    threadId,
    plugins: [fuelPlugin, askPlugin, choicesPlugin, documentDisplayPlugin],
    pipeline: "markdown",
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!authority || renderStatus === "loading") {
      return;
    }
    const summary = summarizeThread(messages);
    if (summary) {
      rememberThreadSummary(threadId, summary);
    }
  }, [messages, authority, renderStatus, threadId]);
  const lastMessage = messages.at(-1);
  const currentWork =
    (authority?.state === "running" || authority?.state === "parked") &&
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
    <ReplyFocusProvider>
      <div className="chat-app">
        {(error || commandError || reconnecting) && (
          <Card.Root className="error-card" tone="error" padding={4}>
            <p role="alert">{error?.message ?? commandError ?? "Restoring connection…"}</p>
            <Button
              type="button"
              variant="outline"
              disabled={reconnecting}
              onClick={async () => {
                setReconnecting(true);
                setCommandError(null);
                clearError();
                try {
                  await reconnect();
                } catch (failure) {
                  setCommandError(String(failure));
                } finally {
                  setReconnecting(false);
                }
              }}
            >
              {reconnecting ? "Reconnecting…" : "Reconnect"}
            </Button>
          </Card.Root>
        )}

        <CancelWorkflow.Provider
          value={
            authority && ["running", "parked", "recovering"].includes(authority.state)
              ? async () => {
                  setCommandError(null);
                  try {
                    await stop();
                  } catch (failure) {
                    setCommandError(String(failure));
                  }
                }
              : undefined
          }
        >
          <CurrentWorkflowActivity.Provider value={currentWork}>
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
                      <span className="message-status">
                        {message.role === "user" ? "sent" : ""}
                      </span>
                    </Stack>
                    <div className="message-parts">
                      {message.parts.map((part) => (
                        <Part key={part.id} part={part} />
                      ))}
                    </div>
                  </Card.Root>
                ))}
            </section>
          </CurrentWorkflowActivity.Provider>
        </CancelWorkflow.Provider>

        <Card.Root className="composer-card" tone="raised" padding={5}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim() && canSendMessage) {
                setCommandError(null);
                rememberThread(threadId);
                const submittedPrompt = prompt;
                void sendMessage(submittedPrompt)
                  .then(() => setPrompt((current) => (current === submittedPrompt ? "" : current)))
                  .catch((failure: unknown) => setCommandError(String(failure)));
              }
            }}
          >
            <label className="workflow-language">
              Workflow language
              <select
                value={language}
                disabled={!canSendMessage}
                onChange={(event) => {
                  const next = workflowLanguage(event.target.value);
                  setLanguage(next);
                  localStorage.setItem(`workflow-language:${threadId}`, next);
                }}
              >
                <option value="scheme">Scheme</option>
                <option value="lua">Lua</option>
              </select>
            </label>
            <p className="hint">
              {language === "lua"
                ? "Lua supports conversational steps and loops. Child workflows, timers and concurrent tasks are not available."
                : "Scheme supports conversational steps, loops and child workflows. Timers and concurrent tasks are not available."}
            </p>
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
              <span className="composer-status" role="status">
                {activityLabel}
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
    </ReplyFocusProvider>
  );
}
