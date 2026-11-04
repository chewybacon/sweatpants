import { useChat } from "@sweatpan.tsx/chat";
import type { ReactNode } from "react";
import type { ConversationPart } from "@sweatpan.ts/chat-client";
import type { FileQuestionContract } from "./file-conversation-view.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { ConversationQuestion, ConversationAnswerReceipt } from "./file-conversation-view.ts";
import type { createConversationViewer } from "./conversation-viewer.ts";

type Viewer = ReturnType<typeof createConversationViewer>;
export interface FileQuestionProps {
  readonly question: ConversationQuestion;
  readonly answer: (
    question: ConversationQuestion,
    text: string,
  ) => Promise<ConversationAnswerReceipt>;
}

/** One application-specific control. A submitted value is held for identical retry;
 * only a receipt confirms acceptance. Missing questions are handled by the parent. */
export function FileQuestion({ question, answer }: FileQuestionProps) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"pending" | "submitting" | "unconfirmed" | "accepted">(
    "pending",
  );
  const inFlight = useRef(false);
  const submitted = useRef<string | undefined>(undefined);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function submit() {
    if (inFlight.current || phase === "accepted" || !text.trim()) {
      return;
    }
    const value = submitted.current ?? text;
    submitted.current = value;
    inFlight.current = true;
    setPhase("submitting");
    try {
      await answer(question, value);
      if (active.current) {
        setPhase("accepted");
      }
    } catch {
      if (active.current) {
        setPhase("unconfirmed");
      }
    } finally {
      inFlight.current = false;
    }
  }
  const label =
    question.context.step === "read"
      ? "File contents"
      : question.context.step === "confirm"
        ? "Confirmation"
        : "Repair response";
  return (
    <section aria-label={`Question about ${question.context.path}`}>
      <h2>{question.context.path}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId}>{label}</label>
        <textarea
          id={inputId}
          value={text}
          required
          disabled={phase !== "pending"}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={phase === "submitting" || phase === "accepted" || !text.trim()}
        >
          {phase === "unconfirmed" ? "Retry same answer" : "Send answer"}
        </button>
      </form>
      <p role="status">
        {phase === "pending"
          ? "Waiting for your answer."
          : phase === "submitting"
            ? "Sending answer…"
            : phase === "accepted"
              ? "Answer accepted."
              : "Answer not confirmed. Retry the same answer or reconnect to check the conversation."}
      </p>
    </section>
  );
}

/** Thin React consumer of the headless viewer. Caller owns the viewer and server
 * execution. Unmount never closes their lifetime; reconnect is explicit and read-only. */
export function FileConversationPanel({ viewer }: { readonly viewer: Viewer }) {
  const { view, status } = useChat(viewer);
  const loading = status === "idle" || status === "loading";
  useEffect(() => {
    void viewer.refresh().catch(() => undefined);
  }, [viewer]);
  function renderParts(parts: readonly ConversationPart<FileQuestionContract>[]): ReactNode {
    return parts.map((part) => {
      if (part.type === "text") {
        return <p key={part.id}>{part.text}</p>;
      }
      if (part.type === "message") {
        return (
          <article key={part.id} aria-label={part.role}>
            {renderParts(part.parts)}
          </article>
        );
      }
      if (part.type === "tool-call") {
        return (
          <section key={part.id} aria-label={`Tool: ${part.name}`}>
            <p>Tool: {part.name}</p>
            {renderParts(part.parts)}
            {part.output !== undefined && <p>Result: {part.output}</p>}
          </section>
        );
      }
      const target = view?.questions.find((question) => question.id === part.id);
      return part.state === "pending" && target ? (
        <FileQuestion
          key={part.id}
          question={target}
          answer={(question, text) => viewer.answer(question, text)}
        />
      ) : (
        <section key={part.id} aria-label={`Question about ${part.question.path}`}>
          <p>
            {part.question.path}:{" "}
            {part.state === "answered"
              ? "Answer recorded."
              : part.state === "cancelled"
                ? "Question cancelled."
                : "Refreshing question availability."}
          </p>
          {part.response !== undefined && <p>{part.response}</p>}
        </section>
      );
    });
  }
  return (
    <main aria-label="File conversation">
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          void viewer.refresh().catch(() => undefined);
        }}
      >
        Reconnect
      </button>
      {loading && <p role="status">Loading conversation…</p>}
      {status === "error" && (
        <p role="alert">Could not refresh the conversation. Try reconnecting.</p>
      )}
      {view?.turns.map((turn) => (
        <section key={turn.execution} aria-label={`Turn ${turn.ordinal}`}>
          {renderParts(turn.messages)}
          <p>
            {turn.status === "completed"
              ? "Turn complete."
              : turn.status === "cancelled"
                ? "Turn cancelled."
                : "Turn not complete."}
          </p>
        </section>
      ))}
      {view && view.questions.length === 0 && <p>No questions awaiting an answer.</p>}
    </main>
  );
}
