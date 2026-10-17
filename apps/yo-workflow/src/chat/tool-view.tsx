import { toolLabel, toolStatus, workflowFailure } from "./activity.ts";
import { SettledDocument } from "./choices-plugin.tsx";
import type { ReactChatUIPart } from "@sweatpants/react-chat";
import { WorkflowActivity } from "./workflow-activity.tsx";
import { ProgramPreview } from "./program-preview.tsx";
import { ReplyForm } from "./ask-plugin.tsx";
import { askParameters } from "../workflow/tools/ask.ts";
import { PendingToolReply, readReply, stringField } from "./reply.tsx";

type ToolPart = Extract<ReactChatUIPart, { type: "tool-call" }>;

function ToolCard({ part }: { part: ToolPart }) {
  const complete = part.state === "output-available";
  const status = toolStatus(part);
  const failure = workflowFailure(part);
  const source = ["tisyn", "scheme"].includes(part.name)
    ? stringField(part.input, "program")
    : undefined;
  const echo = complete && part.name === "echo" ? stringField(part.output, "message") : undefined;
  const reply = complete && part.name === "ask" ? readReply(part.output) : undefined;
  const askInput = part.name === "ask" ? askParameters.safeParse(part.input) : undefined;
  const hasReplyRenderer = part.parts.some(
    (child) => child.type === "elicit" && child.key === "reply" && child.parts.length > 0,
  );
  // The settled tool result also works after reconnect, when local plugin UI is gone.
  // Replace only this tool's reply interaction; retain other children and all raw data.
  const children = reply
    ? part.parts.filter((child) => child.type !== "elicit" || child.key !== "reply")
    : part.parts;
  return (
    <PendingToolReply.Provider value={!complete && part.state !== "output-error"}>
      <section
        className="tool"
        data-tool-name={part.name}
        data-tool-state={part.state}
        data-call-id={part.callId}
      >
        <div className="tool-heading">
          <strong>
            {part.name === "scheme"
              ? stringField(part.input, "title") || toolLabel(part.name)
              : toolLabel(part.name)}
          </strong>
          <span className={`tool-status ${failure ? "output-error" : part.state}`} role="status">
            {status}
          </span>
        </div>
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
        {source !== undefined && part.name !== "scheme" && part.state !== "input-streaming" && (
          <ProgramPreview source={source} language={part.name === "scheme" ? "scheme" : "tisyn"} />
        )}
        {echo !== undefined && (
          <div className="tool-result">
            <span className="field-label">Echoed</span>
            <blockquote>{echo || "(empty message)"}</blockquote>
          </div>
        )}
        {reply && (
          <ReplyForm
            {...(askInput?.success ? askInput.data : {})}
            prompt={stringField(part.input, "message") ?? "Your reply"}
            response={reply}
            disabled
            onRespond={() => {}}
          />
        )}
        {part.name === "ask" && !reply && !hasReplyRenderer && (
          <p>{stringField(part.input, "message")}</p>
        )}
        {part.errorText && (
          <p className="error" role="alert">
            {part.errorText}
          </p>
        )}
        {part.name === "scheme" && source !== undefined && part.state !== "input-streaming" && (
          <section className="workflow-program" aria-label="Workflow program">
            <h3>Program</h3>
            <ProgramPreview source={source} language="scheme" />
          </section>
        )}
        {part.name === "scheme" && (
          <WorkflowActivity part={part} render={(child) => <Part key={child.id} part={child} />} />
        )}
        {part.name !== "scheme" && children.length > 0 && (
          <div className="tool-children">
            {children.map((child) =>
              child.type === "elicit" &&
              child.state !== "pending" &&
              ((part.name === "present_choices" && child.key === "choose") ||
                (part.name === "display_document" && child.key === "display")) ? (
                <SettledDocument
                  key={child.id}
                  context={child.context}
                  fallback={<Part part={child} />}
                />
              ) : (
                <Part key={child.id} part={child} />
              ),
            )}
          </div>
        )}
        {["tisyn", "scheme"].includes(part.name) && complete && (
          <details className="tool-data">
            <summary>Workflow result</summary>
            <pre>{JSON.stringify(part.output, null, 2)}</pre>
          </details>
        )}
        {complete && !["tisyn", "scheme"].includes(part.name) && (
          <details className="tool-data">
            <summary>Result</summary>
            <pre>{JSON.stringify(part.output, null, 2)}</pre>
          </details>
        )}
      </section>
    </PendingToolReply.Provider>
  );
}

/** Match the renderer so protocol-only messages do not create empty chat cards. */
export function hasVisiblePart(part: ReactChatUIPart): boolean {
  switch (part.type) {
    case "text":
      return part.rendered.trim().length > 0;
    case "reasoning":
    case "tool-call":
      return true;
    case "message":
      return part.message.parts.some(hasVisiblePart);
    case "activity":
      return part.presentation !== "opaque";
    case "elicit":
      return part.parts.some(hasVisiblePart);
    case "render":
      return part.node !== null && part.node !== undefined && typeof part.node !== "boolean";
    default:
      return false;
  }
}

export function Part({ part }: { part: ReactChatUIPart }) {
  if (!hasVisiblePart(part)) return null;
  switch (part.type) {
    case "text":
      return <div dangerouslySetInnerHTML={{ __html: part.rendered }} />;
    case "reasoning":
      return (
        <details>
          <summary>{part.state === "streaming" ? "Thinking…" : "Reasoning"}</summary>
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
    case "activity":
      if (part.presentation === "opaque") return null;
      return (
        <section className="nested-activity" data-activity-id={part.id}>
          <div className="tool-heading">
            <strong>{part.activityType}</strong>
            <span className="tool-status">
              {
                {
                  running: "In progress",
                  complete: "Completed",
                  error: "Failed",
                  cancelled: "Cancelled",
                }[part.state]
              }
            </span>
          </div>
          {part.parts.map((child) => (
            <Part key={child.id} part={child} />
          ))}
        </section>
      );
    case "elicit":
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
