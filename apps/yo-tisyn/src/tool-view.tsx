import type { ReactChatUIPart } from "@sweatpants/react-chat";
import { ProgramPreview } from "./program-preview.tsx";
import { readReply, ReplyOutcome, stringField } from "./reply.tsx";

type ToolPart = Extract<ReactChatUIPart, { type: "tool-call" }>;

function waitingForReply(part: ReactChatUIPart): boolean {
  if (part.type === "elicit" && part.state === "pending") {
    return true;
  }
  if (part.type === "message") {
    return part.message.parts.some(waitingForReply);
  }
  return "parts" in part && part.parts.some(waitingForReply);
}

function ToolCard({ part }: { part: ToolPart }) {
  const complete = part.state === "output-available";
  const status = complete
    ? "Completed"
    : part.state === "output-error"
      ? "Failed"
      : part.state === "input-streaming"
        ? "Receiving input"
        : waitingForReply(part)
          ? "Waiting for reply"
          : "Running";
  const source = part.name === "tisyn" ? stringField(part.input, "program") : undefined;
  const echo = complete && part.name === "echo" ? stringField(part.output, "message") : undefined;
  const reply = complete && part.name === "ask" ? readReply(part.output) : undefined;
  const hasReplyRenderer = part.parts.some(
    (child) => child.type === "elicit" && child.key === "reply" && child.parts.length > 0,
  );
  // The settled tool result also works after reconnect, when local plugin UI is gone.
  // Replace only this tool's reply interaction; retain other children and all raw data.
  const children = reply
    ? part.parts.filter((child) => child.type !== "elicit" || child.key !== "reply")
    : part.parts;
  return (
    <section
      className="tool"
      data-tool-name={part.name}
      data-tool-state={part.state}
      data-call-id={part.callId}
    >
      <div className="tool-heading">
        <strong>
          {part.name === "tisyn"
            ? "Tisyn workflow"
            : part.name === "echo"
              ? "Echo"
              : part.name === "ask"
                ? "Ask you"
                : part.name}
        </strong>
        <span className={`tool-status ${part.state}`} role="status">
          {status}
        </span>
      </div>
      {source !== undefined && <ProgramPreview source={source} />}
      {echo !== undefined && (
        <div className="tool-result">
          <span className="field-label">Echoed</span>
          <blockquote>{echo || "(empty message)"}</blockquote>
        </div>
      )}
      {reply && (
        <section className="reply">
          <strong>{stringField(part.input, "message") ?? "Your reply"}</strong>
          <ReplyOutcome response={reply} />
        </section>
      )}
      {part.name === "ask" && !reply && !hasReplyRenderer && (
        <p>{stringField(part.input, "message")}</p>
      )}
      {complete && part.name !== "tisyn" && echo === undefined && !reply && (
        <div className="tool-result">
          <span className="field-label">Result</span>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </div>
      )}
      {part.errorText && (
        <p className="error" role="alert">
          {part.errorText}
        </p>
      )}
      {children.length > 0 && (
        <div className="tool-children">
          {children.map((child) => (
            <Part key={child.id} part={child} />
          ))}
        </div>
      )}
      {part.name === "tisyn" && complete && (
        <details className="tool-data">
          <summary>Workflow result</summary>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </details>
      )}
      {source === undefined && (
        <details className="tool-data">
          <summary>Input</summary>
          <pre>
            {JSON.stringify(
              part.input ??
                part.rawInput ??
                (part.state === "input-streaming" ? "Receiving input…" : null),
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {(reply || echo !== undefined) && (
        <details className="tool-data">
          <summary>Result data</summary>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

export function Part({ part }: { part: ReactChatUIPart }) {
  switch (part.type) {
    case "text":
      return <div dangerouslySetInnerHTML={{ __html: part.rendered }} />;
    case "reasoning":
      return (
        <details>
          <summary>Reasoning</summary>
          <div dangerouslySetInnerHTML={{ __html: part.rendered }} />
        </details>
      );
    case "tool-call":
      return <ToolCard part={part} />;
    case "message":
      return (
        <>
          {part.message.parts.map((child) => (
            <Part key={child.id} part={child} />
          ))}
        </>
      );
    case "elicit":
    case "activity":
      return (
        <>
          {part.parts.map((child) => (
            <Part key={child.id} part={child} />
          ))}
        </>
      );
    case "render":
      return <>{part.node}</>;
    default:
      return null;
  }
}
