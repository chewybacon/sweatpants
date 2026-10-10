import { useRef, useState } from "react";
import { useChat } from "@sweatpants/react-chat";
import { Part } from "./tool-view.tsx";
import { askPlugin } from "./ask-plugin.tsx";
import { PromptExamples } from "./prompt-examples.tsx";
export function App() {
  const [threadId] = useState(() => {
    const existing = localStorage.getItem("yo-tisyn.thread");
    const id = existing ?? crypto.randomUUID();
    localStorage.setItem("yo-tisyn.thread", id);
    return id;
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
    <main>
      <header>
        <small>30-MINUTE SPIKE · LOCAL / TRUSTED USE ONLY</small>
        <h1>yo-tisyn</h1>
        <p>One model tool. Parsed Tisyn. Existing Sweatpants durable children and elicitation.</p>
        <p>
          Bound tools: <code>echo</code> and <code>ask</code> · {status} · renderer {renderStatus}
        </p>
        <button
          onClick={() => {
            localStorage.removeItem("yo-tisyn.thread");
            location.reload();
          }}
        >
          New conversation
        </button>
      </header>
      {(error || commandError) && (
        <p className="error" role="alert">
          {error?.message ?? commandError}
        </p>
      )}
      <section aria-label="Conversation">
        {messages.length === 0 && !busy && (
          <PromptExamples
            onSelect={(example) => {
              setPrompt(example);
              textarea.current?.focus();
            }}
          />
        )}
        {messages.map((message) => (
          <article key={message.id}>
            <h2>{message.role}</h2>
            {message.parts.map((part) => (
              <Part key={part.id} part={part} />
            ))}
          </article>
        ))}
      </section>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim() && canSendMessage) {
            setCommandError(null);
            void sendMessage(prompt).catch((failure: unknown) => setCommandError(String(failure)));
            setPrompt("");
          }
        }}
      >
        <label>
          Task
          <textarea
            ref={textarea}
            rows={4}
            value={prompt}
            placeholder="Choose an example above, or describe your own workflow…"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button disabled={!prompt.trim() || !canSendMessage || renderStatus !== "ready"}>
          Send
        </button>
        <button
          type="button"
          disabled={!busy}
          onClick={() => {
            void stop().catch((failure: unknown) => setCommandError(String(failure)));
          }}
        >
          Stop
        </button>
      </form>
      <footer>
        Conversation: {threadId}
        <br />
        Reply resume and completed tool cards survive reload. Trusted local spike only. See
        README.md for validation results and remaining limits.
      </footer>
    </main>
  );
}
