import { MessageCirclePlus, PanelLeftOpen, RefreshCcw, Terminal } from "lucide-react";
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
import { Input } from "@/components/ui/input";
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
    <div
      className="my-3 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-3"
      data-testid="tool-call-block"
      data-call-id={toolCall.callId}
    >
      <div className="mb-2 text-[11px] uppercase tracking-[0.25em] text-sky-300/70">
        Tool · {toolCall.name}
      </div>
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
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid={`message-${message.role}`}
    >
      <div className="max-w-3xl rounded-[24px] border border-slate-800 bg-slate-900/90 px-5 py-4 text-slate-100 shadow-black/20">
        <div className="mb-2 text-[11px] uppercase tracking-[0.28em] text-sky-300/70">
          {isUser ? "You" : isSystem ? "System" : "Assistant"}
          {busy ? " - streaming" : ""}
        </div>

        {message.parts.map((part) => renderPart(part))}
      </div>
    </div>
  );
}

async function listThreads(namespace: string): Promise<ThreadSummary[]> {
  const response = await fetch(
    `/api/threaded-chat/threads?namespace=${encodeURIComponent(namespace)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to list ${namespace} threads (${response.status})`);
  }
  const data = (await response.json()) as { threads: ThreadSummary[] };
  return data.threads;
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
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    onMetadata(threadId, summarizeThread(messages));
  }, [messages, onMetadata, threadId]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || !canCompose) {
        return;
      }
      sendMessage(content, canInterruptParkedTurn ? { whenBusy: "interrupt" } : undefined);
      onDraftChange("");
    },
    [canCompose, canInterruptParkedTurn, draft, onDraftChange, sendMessage],
  );

  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Durable Threads</div>
          <div className="font-serif text-xl text-slate-100">{lifecycleLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onInspectorToggle}
            className={cn("rounded-lg", inspectorOpen && "bg-sky-500/15 text-sky-300")}
            title="Toggle stream inspector"
          >
            <Terminal className="size-4" />
          </Button>
          <div className="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs text-sky-200">
            {threadId}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-slate-400">
            <div className="rounded-full border border-amber-200/10 bg-amber-200/5 px-4 py-1 text-xs uppercase tracking-[0.35em] text-amber-200/70">
              Empty Thread
            </div>
            <h2 className="font-serif text-3xl text-slate-100">Start a durable conversation</h2>
            <p className="max-w-md text-sm leading-6">
              Choose a prompt below or write your own message to begin.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {definition.suggestions.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  onClick={() => onDraftChange(suggestion.message)}
                  disabled={!canCompose}
                  className="rounded-full border border-slate-700 bg-slate-900/80 px-4 py-2 text-xs text-slate-300 transition hover:border-sky-400 hover:text-sky-200 disabled:opacity-50"
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-slate-800/80 bg-slate-950/90 px-4 py-4 md:px-6">
        {error && (
          <div className="mb-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error.message}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 md:flex-row">
          <Input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Type a message..."
            disabled={!canCompose}
            className="h-14 rounded-2xl border-slate-700 bg-slate-900/90 px-5 text-base"
          />
          {turnActive && !canInterruptParkedTurn ? (
            <Button
              type="button"
              onClick={stop}
              className="h-14 rounded-2xl bg-red-500 px-6 text-white hover:bg-red-400"
            >
              {busy ? "Stop" : "Cancel turn"}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!draft.trim() || !canCompose}
              className="h-14 rounded-2xl bg-sky-500 px-6 text-white hover:bg-sky-400"
            >
              Send
            </Button>
          )}
        </form>
      </div>
    </>
  );
}

export function ChatDemoShell({ definition }: { readonly definition: ChatDemoDefinition }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
          let nextThreads = await listThreads(definition.namespace);
          let nextSelected =
            typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
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

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.16),_transparent_30%),linear-gradient(180deg,_#0f172a_0%,_#111827_52%,_#0b1220_100%)] text-slate-100">
      <div className="mx-auto flex h-[calc(100vh-64px)] min-h-0 flex-col gap-4 p-4 md:flex-row md:p-6">
        <aside
          className={cn(
            "w-full shrink-0 flex-col rounded-[28px] border border-amber-200/10 bg-slate-950/70 p-4 shadow-2xl shadow-black/30 backdrop-blur md:flex md:w-80",
            sidebarOpen ? "flex" : "hidden",
          )}
        >
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.35em] text-amber-300/70">Chat Demo</div>
              <h1 className="font-serif text-2xl text-amber-50">{definition.label}</h1>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(false)}
              className="md:hidden"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>

          <div className="mb-4 flex gap-2">
            <Button
              onClick={() => void handleNewThread()}
              disabled={loading}
              className="flex-1 bg-amber-400 text-slate-950 hover:bg-amber-300"
            >
              <span data-testid="thread-create" className="contents">
                <MessageCirclePlus className="size-4" />
                New thread
              </span>
            </Button>
            <Button variant="outline" size="icon" onClick={() => void hydrate(true)}>
              <RefreshCcw className="size-4" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                data-testid="thread-item"
                data-thread-id={thread.id}
                aria-pressed={selectedThreadId === thread.id}
                onClick={() => handleSelectThread(thread.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${selectedThreadId === thread.id ? "border-amber-300 bg-amber-100/15 ring-2 ring-amber-300/40 shadow-lg shadow-amber-500/20" : "border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900"}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="truncate font-medium text-slate-100">{thread.title}</div>
                  <div
                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${selectedThreadId === thread.id ? "bg-amber-300 text-slate-950" : "border border-slate-700 text-slate-500"}`}
                  >
                    {selectedThreadId === thread.id ? "Active" : shortThreadId(thread.id)}
                  </div>
                </div>
                <div className="line-clamp-2 text-xs text-slate-400">
                  {thread.lastMessagePreview}
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-slate-500">
                  <span>{thread.messageCount} messages</span>
                  <span>{shortThreadId(thread.id)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[32px] border border-slate-800/80 bg-slate-950/75 shadow-2xl shadow-black/30 backdrop-blur">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4 md:hidden">
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen((open) => !open)}>
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>

          {!hydrated || loading || !selectedThreadId ? (
            <div className="flex h-full items-center justify-center text-slate-400">
              Loading threads...
            </div>
          ) : (
            <DemoThreadPanel
              key={`${selectedThreadId}-${sessionMountKey}`}
              definition={definition}
              threadId={selectedThreadId}
              inspectorOpen={inspectorOpen}
              inspectorStore={inspectorStore}
              onInspectorToggle={handleInspectorToggle}
              onMetadata={handleMetadata}
              draft={drafts[selectedThreadId] ?? ""}
              onDraftChange={(value) => handleDraftChange(selectedThreadId, value)}
            />
          )}

          {error && (
            <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200 md:px-6">
              {error}
            </div>
          )}
        </main>

        {inspectorOpen && selectedThreadId && (
          <StreamInspector
            threadId={selectedThreadId}
            store={inspectorStore}
            onClose={handleInspectorToggle}
          />
        )}
      </div>
    </div>
  );
}
