import { createContext, useContext, useState, useId, type ReactNode } from "react";
import { createChatContext } from "@sweatpan.tsx/chat";
import { SubmissionRejected, type View, type Submission } from "./contracts.ts";
import type { BrowserChat } from "./transport.ts";
const binding = createChatContext<View, never, never>();
const SubmissionContext = createContext<BrowserChat["submit"] | undefined>(undefined);
export function ChatProvider({
  client,
  children,
}: {
  readonly client: BrowserChat;
  readonly children: ReactNode;
}) {
  return (
    <binding.ChatProvider client={client}>
      <SubmissionContext.Provider value={client.submit}>{children}</SubmissionContext.Provider>
    </binding.ChatProvider>
  );
}
export function useChat() {
  const submit = useContext(SubmissionContext);
  if (!submit) {
    throw new Error("Missing application ChatProvider");
  }
  const { view, status, error, refresh } = binding.useChat();
  return { view, status, error, refresh, submit };
}
function Messages() {
  const { view, status, refresh } = useChat();
  return (
    <>
      <header>
        <h1>
          yo-chat <small>v2</small>
        </h1>
        <button
          onClick={() => {
            void refresh().catch(() => undefined);
          }}
        >
          Refresh
        </button>
      </header>
      <section aria-label="Messages">
        {view?.messages.map((message) => (
          <article key={message.id} aria-label={message.role}>
            <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
            {message.parts.map((part) => (
              <p key={part.id}>{part.text}</p>
            ))}
          </article>
        ))}
      </section>
      {status === "error" && <p role="alert">Could not load the conversation.</p>}
      {view?.status === "running" && (
        <p role="status">This turn has not completed. Refresh to check its state.</p>
      )}
    </>
  );
}
function Composer() {
  const promptId = useId();
  const { view, submit: send, refresh } = useChat();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Submission>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"rejected" | "uncertain">();
  const canSubmit =
    !busy &&
    Boolean(view) &&
    (Boolean(pending) ||
      (Boolean(text.trim()) && (view?.status === "empty" || view?.status === "completed")));
  async function submit() {
    if (!canSubmit || !view) {
      return;
    }
    const command = pending ?? { command: crypto.randomUUID(), prompt: text, after: view.latest };
    setPending(command);
    setBusy(true);
    setError(undefined);
    try {
      await send(command);
      setPending(undefined);
      setText("");
    } catch (failure) {
      if (failure instanceof SubmissionRejected) {
        setPending(undefined);
        setError("rejected");
      } else {
        setError("uncertain");
      }
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={promptId}>Message</label>
      <textarea
        id={promptId}
        value={text}
        maxLength={16000}
        disabled={busy || Boolean(pending)}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <button disabled={!canSubmit}>
        {busy ? "Waiting for response…" : pending ? "Retry same message" : "Send"}
      </button>
      {error && (
        <p role="alert">
          {error === "rejected"
            ? "Message was not submitted. Your draft is editable; check the refreshed conversation before sending again."
            : "Submission not confirmed. Retry keeps the same message ID. Refreshing alone never reruns the model."}
        </p>
      )}
    </form>
  );
}
export function Chat() {
  return (
    <main>
      <Messages />
      <Composer />
    </main>
  );
}
