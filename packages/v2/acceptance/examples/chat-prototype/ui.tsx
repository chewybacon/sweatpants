import {
  createContext,
  useContext,
  useState,
  useId,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createChatContext } from "@sweatpan.tsx/chat";
import {
  SubmissionRejected,
  type View,
  type Submission,
  type Answer,
  type AnswerReceipt,
  type Question,
} from "./contracts.ts";
import type { BrowserChat } from "./transport.ts";
import { ElicitViews } from "@sweatpan.tsx/chat";
import { questionKey, type FlightFrontend } from "./flight-frontend.tsx";
const FlightContext = createContext<FlightFrontend | undefined>(undefined);
const binding = createChatContext<View, Answer, AnswerReceipt>();
const SubmissionContext = createContext<BrowserChat["submit"] | undefined>(undefined);
export function ChatProvider({
  client,
  frontend,
  children,
}: {
  readonly client: BrowserChat;
  readonly frontend?: FlightFrontend;
  readonly children: ReactNode;
}) {
  return (
    <binding.ChatProvider client={client}>
      <SubmissionContext.Provider value={frontend?.submit ?? client.submit}>
        <FlightContext.Provider value={frontend}>{children}</FlightContext.Provider>
      </SubmissionContext.Provider>
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
            {message.parts.map((part) =>
              part.type === "text" ? (
                <p key={part.id} data-state={part.state}>
                  {part.text}
                </p>
              ) : part.type === "code-run" ? (
                <section key={part.id} aria-label="Lua program" className="code-run">
                  <h2>Lua program · {part.run.result?.status ?? part.run.state}</h2>
                  <pre>
                    <code>{part.run.source}</code>
                  </pre>
                  {part.questions.map((question) => (
                    <FlightQuestion key={questionKey(question)} question={question} />
                  ))}
                  {part.run.result && (
                    <pre aria-label="Program result">
                      {JSON.stringify(part.run.result, null, 2)}
                    </pre>
                  )}
                </section>
              ) : part.type === "question" ? (
                <FlightQuestion key={part.id} question={part.question} />
              ) : (
                <section key={part.id} className="flight-summary">
                  <h2>Demo selection saved</h2>
                  <p>
                    {part.selection.flight.airline} to {part.selection.destination} ·{" "}
                    {part.selection.flight.departure} → {part.selection.flight.arrival} · Seat{" "}
                    {part.selection.seat}
                  </p>
                  <small>No real reservation or payment was made.</small>
                </section>
              ),
            )}
          </article>
        ))}
      </section>
      {status === "error" && <p role="alert">Could not load the conversation.</p>}
      {view?.status === "running" && !view.questions.length && (
        <p role="status">
          {view.active
            ? "Last observed: generating. Text is provisional until accepted."
            : "This turn is unresolved. Retained provisional text is not a completed response."}
        </p>
      )}
    </>
  );
}
function FlightQuestion({ question }: { readonly question: Question }) {
  const frontend = useContext(FlightContext);
  if (!frontend) {
    return <p>A flight-enabled frontend is needed to answer this question.</p>;
  }
  return <ActiveFlightQuestion frontend={frontend} question={question} />;
}
function ActiveFlightQuestion({
  frontend,
  question,
}: {
  readonly frontend: FlightFrontend;
  readonly question: Question;
}) {
  const issues = useSyncExternalStore(frontend.subscribe, frontend.getSnapshot);
  const issue = issues.find((value) => value.id === questionKey(question));
  return (
    <section aria-label={question.kind === "pickFlight" ? "Flight choice" : "Seat choice"}>
      <ElicitViews host={frontend.host} execution={question.execution} />
      {issue && (
        <p role="alert">
          {issue.message}{" "}
          {issue.retryable && (
            <button onClick={() => frontend.retry(issue.id)}>Retry same answer</button>
          )}
        </p>
      )}
    </section>
  );
}
function Composer() {
  const promptId = useId();
  const { view, submit: send, refresh } = useChat();
  const [text, setText] = useState("");
  const [codeMode, setCodeMode] = useState(false);
  const [pending, setPending] = useState<{
    command: Submission;
    send: typeof send;
    refresh: typeof refresh;
  }>();
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
    // An uncertain command retains its originating session even if the provider
    // changes. New commands use the current session after this attempt settles.
    const attempt = pending ?? {
      command: {
        command: crypto.randomUUID(),
        prompt: text,
        after: view.latest,
        mode: codeMode ? ("code" as const) : ("tools" as const),
      },
      send,
      refresh,
    };
    setPending(attempt);
    setBusy(true);
    setError(undefined);
    try {
      await attempt.send(attempt.command);
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
      await attempt.refresh().catch(() => undefined);
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
      <label>
        <input
          type="checkbox"
          checked={codeMode}
          disabled={busy || Boolean(pending)}
          onChange={(event) => setCodeMode(event.currentTarget.checked)}
        />
        Use code mode
      </label>
      <button disabled={!canSubmit}>
        {busy ? "Submitting…" : pending ? "Retry same message" : "Send"}
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
