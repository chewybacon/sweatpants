import { useThreadMetadata } from "@/lib/use-thread-metadata";
import {
  Plus,
  PanelLeftOpen,
  RefreshCcw,
  Terminal,
  ArrowUp,
  ArrowDown,
  Square,
  MessageSquare,
} from "lucide-react";
import {
  useChat,
  type ReactChatUIMessage,
  type ReactChatUIPart,
  type UseChatOptions,
} from "@sweatpants/react-chat";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamInspector } from "@/components/StreamInspector";
import {
  createStreamInspectorStore,
  createStreamInspectorTransportMiddleware,
  type StreamInspectorStore,
} from "@/lib/stream-inspector";
import type { ThreadSummary } from "@/lib/threaded-chat-types";
import { Button } from "@/components/ui/button";
import { Drawer } from "./Drawer";
import { demos } from "./demo-navigation";
import { cn } from "@/lib/utils";

type DemoChatOptions = Extract<UseChatOptions, { readonly threadId: string }>;

export interface ChatDemoSuggestion {
  readonly label: string;
  readonly message: string;
}

export interface ChatDemoDefinition {
  readonly namespace: string;
  readonly label: string;
  readonly pipeline?: DemoChatOptions["pipeline"];
  readonly plugins?: DemoChatOptions["plugins"];
  readonly suggestions: readonly ChatDemoSuggestion[];
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shortThreadId(threadId: string): string {
  return threadId.split(":").at(-1)?.slice(0, 8) ?? threadId.slice(0, 8);
}

function getMessagePlainText(message: ReactChatUIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return part.text;
      }
      if (part.type === "tool-call" && typeof part.output === "string") {
        return part.output;
      }
      return "";
    })
    .join("\n");
}

function summarizeThread(
  messages: readonly ReactChatUIMessage[],
): Pick<ThreadSummary, "title" | "lastMessagePreview" | "messageCount"> {
  const visibleMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const titleSource = visibleMessages.find((message) => message.role === "user");
  const lastSource = visibleMessages[visibleMessages.length - 1];
  const title = compact(titleSource ? getMessagePlainText(titleSource) : "") || "New thread";
  const preview = compact(lastSource ? getMessagePlainText(lastSource) : "") || "No messages yet";

  return {
    title: title.length > 40 ? `${title.slice(0, 37)}...` : title,
    lastMessagePreview: preview.length > 80 ? `${preview.slice(0, 77)}...` : preview,
    messageCount: visibleMessages.length,
  };
}

function formatToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const record = result as Record<string, unknown>;
  return typeof record["message"] === "string" ? record["message"] : JSON.stringify(result);
}

function ToolCallBlock({
  toolCall,
}: {
  toolCall: Extract<ReactChatUIPart, { type: "tool-call" }>;
}) {
  const hasRenderedChildren = toolCall.parts.length > 0;
  const resultText = toolCall.state === "output-available" ? formatToolResult(toolCall.output) : "";

  return (
    <div className="tool-panel" data-testid="tool-call-block" data-call-id={toolCall.callId}>
      <div className="tool-label">{toolCall.name.replaceAll("_", " ")}</div>
      {toolCall.parts.map((part) => renderPart(part))}
      {!hasRenderedChildren &&
        (toolCall.state === "input-streaming" || toolCall.state === "input-available") && (
          <div className="text-xs text-slate-500 animate-pulse">Running {toolCall.name}...</div>
        )}
      {toolCall.state === "output-available" && resultText && (
        <div className="mt-3 rounded border border-emerald-700/50 bg-emerald-950/20 p-3 text-sm text-emerald-100">
          {resultText}
        </div>
      )}
      {toolCall.state === "output-error" && toolCall.errorText && (
        <div className="text-xs text-red-300">Error: {toolCall.errorText}</div>
      )}
    </div>
  );
}

function renderPart(part: ReactChatUIPart): ReactNode {
  switch (part.type) {
    case "text":
      return (
        <div
          key={part.id}
          data-testid="message-text"
          className="prose prose-sm max-w-none leading-7 prose-invert"
          dangerouslySetInnerHTML={{ __html: part.rendered }}
        />
      );
    case "reasoning":
      return (
        <details key={part.id} className="mb-3 text-xs">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-400">
            Thinking...
          </summary>
          <div
            className="mt-2 rounded bg-slate-950/80 p-2 text-slate-400 italic"
            dangerouslySetInnerHTML={{ __html: part.rendered }}
          />
        </details>
      );
    case "tool-call":
      return <ToolCallBlock key={part.id} toolCall={part} />;
    case "message":
      return (
        <div key={part.id} className="ml-4 border-l border-slate-700 pl-3">
          <MessageBubble message={part.message} />
        </div>
      );
    case "activity":
      return (
        <div key={part.id} className="my-2 rounded border border-slate-700/50 p-2">
          <div className="mb-1 text-xs text-slate-500">
            {part.activityType} · {part.state}
          </div>
          {part.parts.map((child) => renderPart(child))}
        </div>
      );
    case "elicit":
      return (
        <div key={part.id} className="my-2">
          {part.parts.map((child) => renderPart(child))}
          {part.parts.length === 0 && (
            <div className="text-xs text-amber-400">
              {part.message} ({part.state})
            </div>
          )}
        </div>
      );
    case "render":
      return <span key={part.id}>{part.node}</span>;
    default:
      return null;
  }
}

function MessageBubble({ message }: { message: ReactChatUIMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const busy = message.parts.some(
    (part) => (part.type === "text" || part.type === "reasoning") && part.state === "streaming",
  );

  return (
    <div
      className={cn("message-row", isUser && "from-user")}
      data-testid={`message-${message.role}`}
    >
      <div className={cn("message-body", isUser && "user-message")}>
        <div className="message-author">
          {isUser ? "You" : isSystem ? "System" : "Assistant"}
          {busy ? " - streaming" : ""}
        </div>

        {message.parts.map((part) => renderPart(part))}
      </div>
    </div>
  );
}

interface ThreadPage {
  threads: ThreadSummary[];
  nextCursor: string | null;
}
async function listThreads(namespace: string, before?: string): Promise<ThreadPage> {
  const params = new URLSearchParams({ namespace });
  if (before) {
    params.set("before", before);
  }
  const response = await fetch(`/api/threaded-chat/threads?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to list ${namespace} threads (${response.status})`);
  }
  return response.json() as Promise<ThreadPage>;
}

async function createThread(namespace: string): Promise<ThreadSummary> {
  const response = await fetch("/api/threaded-chat/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      namespace,
      id: `${namespace}:${crypto.randomUUID()}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create ${namespace} thread (${response.status})`);
  }
  const data = (await response.json()) as { thread: ThreadSummary };
  return data.thread;
}

async function updateThread(
  threadId: string,
  payload: Pick<ThreadSummary, "title" | "lastMessagePreview" | "messageCount">,
): Promise<ThreadSummary> {
  const response = await fetch(`/api/threaded-chat/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to update thread (${response.status})`);
  }
  const data = (await response.json()) as { thread: ThreadSummary };
  return data.thread;
}

function DemoThreadPanel({
  definition,
  threadId,
  inspectorOpen,
  inspectorStore,
  onInspectorToggle,
  onMetadata,
  draft,
  onDraftChange,
  onHistoryOpen,
}: {
  readonly definition: ChatDemoDefinition;
  readonly threadId: string;
  readonly inspectorOpen: boolean;
  readonly inspectorStore: StreamInspectorStore;
  readonly onInspectorToggle: () => void;
  readonly onMetadata: (
    threadId: string,
    summary: Pick<ThreadSummary, "title" | "lastMessagePreview" | "messageCount">,
  ) => void;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onHistoryOpen: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    followingRef.current = true;
    setShowLatest(false);
  }, []);
  useEffect(() => {
    const textarea = composerRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
    }
  }, [draft]);
  const inspectorTransport = useMemo(
    () => ({
      http: {},
      middleware: createStreamInspectorTransportMiddleware(inspectorStore),
    }),
    [inspectorStore],
  );
  const { messages, authority, status, renderStatus, canSendMessage, sendMessage, stop, error } =
    useChat({
      pipeline: definition.pipeline ?? "full",
      plugins: definition.plugins ?? [],
      threadId,
      transport: inspectorTransport,
    });
  const busy = status === "submitted" || status === "streaming";
  const turnActive =
    authority?.state === "running" ||
    authority?.state === "parked" ||
    authority?.state === "recovering";
  const renderReady = renderStatus === "ready";
  // A parked tool turn is waiting on user interaction. Let an ordinary message
  // supersede it rather than forcing callers to manufacture a resume payload.
  const canInterruptParkedTurn = authority?.state === "parked";
  const canCompose = canSendMessage || canInterruptParkedTurn;
  const lifecycleLabel = !renderReady
    ? "Loading renderer"
    : authority === null
      ? "Hydrating thread"
      : authority.state === "idle"
        ? "Thread ready"
        : authority.state === "parked"
          ? "Waiting for your response"
          : authority.state === "recovering"
            ? "Recovering thread"
            : authority.state === "deleted"
              ? "Thread deleted"
              : "Thread running";

  useEffect(() => {
    if (followingRef.current) {
      scrollToLatest();
    }
  }, [messages, scrollToLatest]);

  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content) {
      return;
    }
    // Renderers and tool panels can resize after a message arrives.
    const observer = new ResizeObserver(() => {
      if (followingRef.current) {
        scrollToLatest();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  useThreadMetadata({
    threadId,
    summary: summarizeThread(messages),
    busy,
    ready: renderReady && authority !== null,
    onMetadata,
  });

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || !canCompose) {
        return;
      }
      followingRef.current = true;
      sendMessage(content, canInterruptParkedTurn ? { whenBusy: "interrupt" } : undefined);
      onDraftChange("");
    },
    [canCompose, canInterruptParkedTurn, draft, onDraftChange, sendMessage],
  );

  return (
    <>
      <header className="conversation-header">
        <button
          className="icon-button mobile-history"
          onClick={onHistoryOpen}
          aria-label="Open threads"
        >
          <PanelLeftOpen size={19} />
        </button>
        <div className="conversation-heading">
          <h1>{definition.label}</h1>
          <div className="conversation-status" role="status">
            <span className={cn("status-dot", busy && "working")} />
            {lifecycleLabel}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onInspectorToggle}
          aria-label="Toggle stream inspector"
          aria-pressed={inspectorOpen}
          className="inspector-toggle"
          title={`Thread ${shortThreadId(threadId)}`}
        >
          <Terminal size={17} />
        </Button>
      </header>
      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const following = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          followingRef.current = following;
          setShowLatest(!following);
        }}
      >
        <div className={cn("conversation-content", messages.length === 0 && "empty-content")}>
          {messages.length === 0 && (authority === null || !renderReady) ? (
            <div className="loading-thread" role="status" aria-busy={!error}>
              {error ? "Unable to load conversation." : "Loading conversation…"}
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-mark">
                <MessageSquare size={26} strokeWidth={1.5} />
              </div>
              <p className="eyebrow">{definition.label}</p>
              <h2>
                {demos.find((demo) => demo.to === `/chat/${definition.namespace}`)?.description ??
                  "What’s on your mind?"}
              </h2>
              <p>Start something new. You can always pick it up later.</p>
              <div className="suggestions">
                {definition.suggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => {
                      onDraftChange(suggestion.message);
                      composerRef.current?.focus();
                    }}
                    disabled={!canCompose}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
        </div>
      </div>
      <div className="composer-area">
        {showLatest && (
          <button className="jump-latest" onClick={scrollToLatest}>
            <ArrowDown size={14} />
            Latest messages
          </button>
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error.message}
          </div>
        )}
        <form onSubmit={handleSubmit} className="composer">
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Type a message..."
            aria-label="Type a message..."
            disabled={!canCompose}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                window.matchMedia("(pointer: fine)").matches
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {turnActive && !canInterruptParkedTurn ? (
            <button
              type="button"
              onClick={stop}
              className="send-button stop-button"
              aria-label={busy ? "Stop" : "Cancel turn"}
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim() || !canCompose}
              className="send-button"
              aria-label="Send"
            >
              <ArrowUp size={20} />
            </button>
          )}
        </form>
        <p className="composer-note">
          {canInterruptParkedTurn
            ? "Make a choice above, or send a message to change direction."
            : "Your conversation is saved as you go."}
        </p>
      </div>
    </>
  );
}

export function ChatDemoShell({ definition }: { readonly definition: ChatDemoDefinition }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [sessionMountKey, setSessionMountKey] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorStore] = useState(() => createStreamInspectorStore());
  const hydrationRef = useRef<Promise<void> | null>(null);
  const hydratedOnceRef = useRef(false);
  const selectionGenerationRef = useRef(0);
  const storageKey = `yo-chat:${definition.namespace}:selected-thread-id`;
  // Every Playwright test gets a new browser storage context but shares the
  // test server's durable metadata. Start those new contexts on a clean
  // thread; a refresh in the same test still restores its selected thread.
  const isolateTestBrowserSession = import.meta.env["VITE_PLAYWRIGHT_TEST_SERVER"] === "1";

  const persistSelection = useCallback(
    (threadId: string | null) => {
      if (typeof window === "undefined") {
        return;
      }
      if (threadId) {
        window.localStorage.setItem(storageKey, threadId);
      } else {
        window.localStorage.removeItem(storageKey);
      }
    },
    [storageKey],
  );

  const hydrate = useCallback(
    (force = false): Promise<void> => {
      if (hydrationRef.current) {
        return hydrationRef.current;
      }
      if (!force && hydratedOnceRef.current) {
        return Promise.resolve();
      }
      hydratedOnceRef.current = true;
      const generation = selectionGenerationRef.current;
      const operation = (async () => {
        inspectorStore.clear();
        setLoading(true);
        setError(null);
        try {
          const page = await listThreads(definition.namespace);
          let nextThreads = page.threads;
          let nextSelected =
            typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
          // Restore an older selected thread with a point lookup, never by paging through the whole list.
          if (nextSelected && !nextThreads.some((thread) => thread.id === nextSelected)) {
            const response = await fetch(
              `/api/threaded-chat/threads/${encodeURIComponent(nextSelected)}`,
            );
            if (response.ok) {
              const { thread } = (await response.json()) as { thread: ThreadSummary };
              if (thread.namespace === definition.namespace) {
                nextThreads = [thread, ...nextThreads];
              }
            } else if (response.status !== 404) {
              throw new Error(`Failed to restore thread (${response.status})`);
            }
          }
          if (nextThreads.length === 0 || (isolateTestBrowserSession && !nextSelected)) {
            const created = await createThread(definition.namespace);
            nextThreads = [created, ...nextThreads];
            nextSelected = created.id;
          }
          if (!nextSelected || !nextThreads.some((thread) => thread.id === nextSelected)) {
            nextSelected = nextThreads[0]?.id ?? null;
          }
          if (selectionGenerationRef.current !== generation) {
            return;
          }
          setThreads(nextThreads);
          setNextCursor(page.nextCursor);
          setSelectedThreadId(nextSelected);
          persistSelection(nextSelected);
          setSessionMountKey((current) => current + 1);
        } catch (cause) {
          if (selectionGenerationRef.current === generation) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        } finally {
          if (selectionGenerationRef.current === generation) {
            setLoading(false);
          }
        }
      })();
      hydrationRef.current = operation;
      void operation.finally(() => {
        if (hydrationRef.current === operation) {
          hydrationRef.current = null;
        }
      });
      return operation;
    },
    [definition.namespace, inspectorStore, isolateTestBrowserSession, persistSelection, storageKey],
  );

  useEffect(() => {
    setHydrated(true);
    void hydrate();
  }, [hydrate]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) {
      return;
    }
    const generation = selectionGenerationRef.current;
    setLoadingMore(true);
    try {
      const page = await listThreads(definition.namespace, nextCursor);
      if (selectionGenerationRef.current !== generation) {
        return;
      }
      setThreads((current) => [
        ...current,
        ...page.threads.filter((thread) => !current.some((existing) => existing.id === thread.id)),
      ]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleNewThread = useCallback(async () => {
    const generation = selectionGenerationRef.current + 1;
    selectionGenerationRef.current = generation;
    const previousThreadId = selectedThreadId;
    setSelectedThreadId(null);
    setLoading(true);
    try {
      setError(null);
      inspectorStore.clear();
      const created = await createThread(definition.namespace);
      if (selectionGenerationRef.current !== generation) {
        return;
      }
      setThreads((previous) => [created, ...previous]);
      setSelectedThreadId(created.id);
      persistSelection(created.id);
      setSessionMountKey((current) => current + 1);
      setSidebarOpen(false);
    } catch (cause) {
      if (selectionGenerationRef.current === generation) {
        setSelectedThreadId(previousThreadId);
        persistSelection(previousThreadId);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (selectionGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  }, [definition.namespace, inspectorStore, persistSelection, selectedThreadId]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setSidebarOpen(false);
      selectionGenerationRef.current += 1;
      inspectorStore.clear();
      setSelectedThreadId(threadId);
      persistSelection(threadId);
      setSessionMountKey((current) => current + 1);
    },
    [inspectorStore, persistSelection],
  );

  const handleMetadata = useCallback(
    (
      threadId: string,
      summary: Pick<ThreadSummary, "title" | "lastMessagePreview" | "messageCount">,
    ) => {
      setThreads((previous) => {
        const existing = previous.find((thread) => thread.id === threadId);
        const now = Date.now();
        const nextThread: ThreadSummary = existing
          ? { ...existing, ...summary, updatedAt: now }
          : {
              namespace: definition.namespace,
              id: threadId,
              createdAt: now,
              updatedAt: now,
              ...summary,
            };
        const next = previous.some((thread) => thread.id === threadId)
          ? previous.map((thread) => (thread.id === threadId ? nextThread : thread))
          : [nextThread, ...previous];
        return [...next].sort((left, right) => right.updatedAt - left.updatedAt);
      });
      void updateThread(threadId, summary)
        .then((thread) => {
          setThreads((previous) =>
            [
              ...(previous.some((item) => item.id === thread.id)
                ? previous.map((item) => (item.id === thread.id ? thread : item))
                : [thread, ...previous]),
            ].sort((left, right) => right.updatedAt - left.updatedAt),
          );
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [definition.namespace],
  );

  const handleDraftChange = useCallback((threadId: string, value: string) => {
    setDrafts((current) => ({ ...current, [threadId]: value }));
  }, []);

  const handleInspectorToggle = useCallback(() => {
    setInspectorOpen((open) => !open);
  }, []);

  const threadList = (
    <>
      <div className="thread-actions">
        <button
          className="new-thread-button"
          onClick={() => void handleNewThread()}
          disabled={loading}
          data-testid="thread-create"
        >
          <Plus size={17} />
          New thread
        </button>
        <button
          className="icon-button"
          onClick={() => void hydrate(true)}
          disabled={loading}
          aria-label="Refresh threads"
        >
          <RefreshCcw size={16} />
        </button>
      </div>
      <p className="thread-list-label">RECENT CONVERSATIONS</p>
      <div className="thread-list">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            data-testid="thread-item"
            data-thread-id={thread.id}
            aria-pressed={selectedThreadId === thread.id}
            onClick={() => handleSelectThread(thread.id)}
            className={cn("thread-item", selectedThreadId === thread.id && "selected")}
          >
            <span className="thread-title">{thread.title}</span>
            <span className="thread-preview">{thread.lastMessagePreview}</span>
            <span className="thread-meta">
              {thread.messageCount} messages{selectedThreadId === thread.id && <span>Current</span>}
            </span>
          </button>
        ))}
        {nextCursor && (
          <Button
            disabled={loadingMore || loading}
            onClick={() => void handleLoadMore()}
            className="w-full"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </>
  );
  return (
    <div className="chat-workspace">
      <aside className="thread-sidebar" aria-label="Threads">
        {threadList}
      </aside>
      <Drawer open={sidebarOpen} onClose={() => setSidebarOpen(false)} title="Threads">
        {sidebarOpen && threadList}
      </Drawer>
      <main className="conversation">
        {!hydrated || loading || !selectedThreadId ? (
          <div className="loading-thread" role="status">
            Loading threads…
          </div>
        ) : (
          <DemoThreadPanel
            key={`${selectedThreadId}-${sessionMountKey}`}
            definition={definition}
            threadId={selectedThreadId}
            inspectorOpen={inspectorOpen}
            inspectorStore={inspectorStore}
            onInspectorToggle={handleInspectorToggle}
            onHistoryOpen={() => setSidebarOpen(true)}
            onMetadata={handleMetadata}
            draft={drafts[selectedThreadId] ?? ""}
            onDraftChange={(value) => handleDraftChange(selectedThreadId, value)}
          />
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
      </main>
      <Drawer
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title="Stream inspector"
        side="right"
      >
        {inspectorOpen && selectedThreadId && (
          <StreamInspector
            threadId={selectedThreadId}
            store={inspectorStore}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </Drawer>
    </div>
  );
}
