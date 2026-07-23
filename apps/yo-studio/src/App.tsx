import { useMemo, useState, type FormEvent } from "react";
import { useChat, type ChatMessage, type ChatToolCall } from "@sweatpants/react-chat";

import { studioView } from "./config.ts";
import { getOrCreateConversationId, replaceConversationId } from "./session-id.ts";

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function formatted(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function ToolCallCard({ part }: { part: ChatToolCall }) {
  const complete = part.state === "complete";
  return (
    <section className={`tool-call ${part.state}`}>
      <header className="tool-call-header">
        <div>
          <span className="tool-glyph">{complete ? "✓" : part.state === "error" ? "!" : "→"}</span>
          <strong>{part.name}</strong>
        </div>
        <span className={`tool-state ${part.state}`}>{part.state}</span>
      </header>
      <details open={part.state === "running" || part.state === "error"}>
        <summary>Input</summary>
        <pre>{formatted(part.arguments)}</pre>
      </details>
      {part.result !== undefined ? (
        <details>
          <summary>Result</summary>
          <pre>{formatted(part.result)}</pre>
        </details>
      ) : null}
      {part.error ? <p className="tool-error">{part.error}</p> : null}
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <strong>{message.role === "user" ? "You" : "Harness"}</strong>
      {message.parts.map((part) => {
        switch (part.type) {
          case "text":
            return <div key={part.id} dangerouslySetInnerHTML={{ __html: part.rendered }} />;
          case "reasoning":
            return (
              <details key={part.id} className="reasoning">
                <summary>Reasoning</summary>
                <div dangerouslySetInnerHTML={{ __html: part.rendered }} />
              </details>
            );
          case "tool-call":
            return <ToolCallCard key={part.id} part={part} />;
          case "tool-result":
            return (
              <details key={part.id} className="tool-result">
                <summary>Tool result</summary>
                <pre>{formatted(part.result)}</pre>
              </details>
            );
        }
      })}
    </article>
  );
}

function DurableChat({ conversationId }: { conversationId: string }) {
  const [task, setTask] = useState("Inspect the workspace and report its current version");
  const { messages, isStreaming, send, abort, error, pipelineReady } = useChat({
    baseUrl: "/api/chat",
    conversationId,
    enabledTools: true,
    pipeline: "markdown",
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (task.trim().length === 0 || isStreaming) {
      return;
    }
    send(task.trim());
    setTask("");
  }

  return (
    <section className="panel chat" aria-live="polite">
      <div className="chat-heading">
        <div>
          <p className="eyebrow">Durable coding harness</p>
          <code>conversation {conversationId.slice(0, 8)}</code>
        </div>
        <span className="status">
          {pipelineReady ? "useChat · durable handler ready" : "loading chat projection"}
        </span>
      </div>
      <div className="transcript">
        {messages.length === 0 ? (
          <p className="empty">Send a task to the journal-native coding harness.</p>
        ) : null}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {isStreaming ? <p className="streaming">Durable activation running…</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>

      <form className="hero" onSubmit={submit}>
        <label htmlFor="task">Coding task</label>
        <textarea
          id="task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          disabled={isStreaming}
        />
        <div className="action-row">
          {isStreaming ? (
            <button type="button" onClick={abort}>
              Cancel
            </button>
          ) : (
            <button type="submit" disabled={task.trim().length === 0}>
              Send with useChat
            </button>
          )}
          <p>
            React owns presentation only. `useChat` talks to `createDurableChatHandler`; the handler
            owns the model loop, journal, native child tools, and workspace effects.
          </p>
        </div>
      </form>
    </section>
  );
}

export function App() {
  const [conversationId, setConversationId] = useState(() =>
    getOrCreateConversationId(window.localStorage),
  );
  const toolNames = useMemo(() => [...studioView.capabilityNames], []);

  function newSession() {
    setConversationId(replaceConversationId(window.localStorage));
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Sweatpants reference assembly</p>
          <h1>yo-studio</h1>
          <p className="lede">
            Author processless durable programs once, then project them through React, HTTP, and MCP
            onto replaceable workspace compute.
          </p>
        </div>
        <button type="button" className="secondary" onClick={newSession}>
          New session
        </button>
      </header>

      <DurableChat key={conversationId} conversationId={conversationId} />

      <div className="grid">
        <section className="panel">
          <p className="eyebrow">Durable program</p>
          <h2>{studioView.program.id}</h2>
          <dl>
            <div>
              <dt>Version</dt>
              <dd>{studioView.program.version}</dd>
            </div>
            <div>
              <dt>Model loop</dt>
              <dd>{studioView.program.modelLoop}</dd>
            </div>
            <div>
              <dt>Model provider</dt>
              <dd>{studioView.modelProvider.model}</dd>
            </div>
            <div>
              <dt>Sampling authority</dt>
              <dd>{studioView.modelSampling.ownership}</dd>
            </div>
            <div>
              <dt>Iterations</dt>
              <dd>{studioView.program.maxIterations}</dd>
            </div>
          </dl>
          <h3>Closed capability map</h3>
          <ul className="tools">
            {toolNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">Workspace placement</p>
          <h2>
            {__YO_STUDIO_WORKSPACE_PLACEMENT__ === "aws"
              ? "AWS Lambda MicroVM"
              : "Local Effection runtime"}
          </h2>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>
                {__YO_STUDIO_WORKSPACE_PLACEMENT__ === "aws"
                  ? `Node ${studioView.sandbox.image.node} · ARM64`
                  : "Node · loopback connector"}
              </dd>
            </div>
            <div>
              <dt>Persistence</dt>
              <dd>{studioView.sandbox.capabilities.workspacePersistence}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{studioView.workspace.policy.network}</dd>
            </div>
          </dl>
          <h3>Named scripts</h3>
          <JsonBlock value={studioView.workspace.scripts} />
        </section>
      </div>

      <section className="panel architecture">
        <p className="eyebrow">One program, multiple projections</p>
        <div className="flow">
          <span>React useChat</span>
          <span>Headless HTTP</span>
          <span>MCP</span>
          <strong>Durable chat handler + ProgramRuntime</strong>
          <span>MicroVM workspace</span>
        </div>
      </section>
    </main>
  );
}
