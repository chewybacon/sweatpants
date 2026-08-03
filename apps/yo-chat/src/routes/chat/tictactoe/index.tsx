/**
 * /chat/tictactoe - Tic-Tac-Toe Game Demo (MCP Standard Sampling)
 *
 * Demonstrates the tictactoe plugin using STANDARD MCP sampling:
 * - Single tool call plays the entire game
 * - Model uses plain text sampling (no structured output)
 * - Often loses because it can't reliably pick strategic moves
 *
 * Compare this to /chat/play-ttt which uses MCP++ extensions
 * (sampleTools, sampleSchema) and wins much more often.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { renderNestedParts } from "@/components/ChatPartTree";
import { useChat, type ChatMessage, type ChatToolCall } from "@sweatpants/react-chat";
import { tictactoePlugin } from "@/tools/tictactoe/plugin.ts";

export const Route = createFileRoute("/chat/tictactoe/")({
  component: TicTacToeDemo,
});

/**
 * Renders a tool call part with its prepared recursive children.
 */
function ToolCallBlock({ toolCall }: { toolCall: ChatToolCall }) {
  const prepared = renderNestedParts(toolCall.parts);
  const hasRenderedChildren = prepared.length > 0;

  return (
    <div className="my-2">
      {prepared.map((child, index) => (
        <span key={`${toolCall.callId}:child:${index}`}>{child}</span>
      ))}

      {!hasRenderedChildren &&
        (toolCall.state === "input-streaming" || toolCall.state === "input-available") && (
          <div className="text-xs text-slate-500 animate-pulse">Running {toolCall.name}...</div>
        )}

      {toolCall.state === "output-error" && toolCall.errorText && (
        <div className="text-xs text-red-400">Error: {toolCall.errorText}</div>
      )}
    </div>
  );
}

/**
 * Renders a single message with its parts.
 */
function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const busy = message.parts.some(
    (part) => (part.type === "text" || part.type === "reasoning") && part.state === "streaming",
  );

  return (
    <div className={`mb-6 ${isUser ? "text-right" : ""}`}>
      <div className={`inline-block max-w-[85%] ${isUser ? "" : "w-full"}`}>
        <div
          className={`text-xs mb-1 font-bold tracking-wider uppercase ${
            isUser ? "text-purple-400" : "text-cyan-400"
          }`}
        >
          {isUser ? "You" : isSystem ? "System" : "Model"}
          {busy && <span className="ml-2 text-emerald-500 animate-pulse">thinking...</span>}
        </div>

        <div
          className={`p-4 rounded-lg ${
            isUser
              ? "bg-purple-950/30 border border-purple-900/50 text-purple-100"
              : "bg-slate-800/50 text-slate-200"
          }`}
        >
          {message.parts.map((part) => {
            if (part.type === "reasoning") {
              return (
                <details key={part.id} className="mb-3 text-xs">
                  <summary className="text-slate-500 cursor-pointer hover:text-slate-400">
                    Thinking...
                  </summary>
                  <div
                    className="mt-2 p-2 bg-slate-900/50 rounded text-slate-400 italic"
                    dangerouslySetInnerHTML={{ __html: part.rendered }}
                  />
                </details>
              );
            }

            if (part.type === "tool-call") {
              return <ToolCallBlock key={part.id} toolCall={part} />;
            }

            if (part.type === "text") {
              return (
                <div
                  key={part.id}
                  className="prose prose-invert prose-sm max-w-none leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: part.rendered }}
                />
              );
            }

            return null;
          })}

          {busy && <span className="inline-block w-2 h-4 bg-cyan-500 ml-0.5 animate-pulse" />}
        </div>
      </div>
    </div>
  );
}

function TicTacToeDemo() {
  const { messages, status, renderStatus, sendMessage, stop, setMessages, error } = useChat({
    conversationId: "tictactoe-chat",
    pipeline: "markdown",
    // Browser interaction is supplied by the plugin.
    // Client plugin registration is local; server tool composition is independent.
    plugins: [tictactoePlugin],
    // Force the first turn into the tool; later turns stay free-form so
    // follow-ups like "who won?" answer from history instead of re-launching.
  });
  const busy = status === "submitted" || status === "streaming";
  const renderReady = renderStatus === "ready";
  const clear = () => setMessages([]);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) {
      return;
    }
    sendMessage({ text: input.trim() });
    setInput("");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-mono">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-3xl font-bold text-cyan-400 mb-2">Tic-Tac-Toe</h1>
            <p className="text-slate-400 text-sm">
              MCP Standard Sampling - Model uses plain text responses
            </p>
            <p className="text-amber-500/70 text-xs mt-1">
              Watch the model struggle without structured output!
            </p>
          </div>
          <div className="text-xs">
            {renderReady ? (
              <span className="text-emerald-500">Pipeline ready</span>
            ) : (
              <span className="text-amber-500 animate-pulse">Loading pipeline...</span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="bg-slate-900 rounded-xl p-6 min-h-[50vh] max-h-[60vh] overflow-y-auto mb-6 border border-slate-800">
          {messages.length === 0 && !busy && (
            <div className="text-slate-600 text-center py-16">
              <div className="text-4xl mb-4">X | O</div>
              <p className="mb-4">Challenge the model to a game!</p>
              <p className="text-xs text-amber-500/50 mb-4">
                (Using MCP standard sampling - no structured output)
              </p>
              <button
                onClick={() => sendMessage({ text: "Let's play tic-tac-toe!" })}
                className="px-4 py-2 bg-cyan-900/30 hover:bg-cyan-900/50 border border-cyan-800 rounded-lg transition-colors"
              >
                Start Game
              </button>
            </div>
          )}

          {messages.map((msg) => (
            <Message key={msg.id} message={msg} />
          ))}

          {error && (
            <div className="p-4 bg-red-950/30 border border-red-900/50 rounded-lg text-red-400 my-4">
              <strong>Error:</strong> {error?.message}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              busy ? "Waiting for response..." : "Type a message... (try: Let's play tic-tac-toe!)"
            }
            disabled={busy}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-6 pr-32 py-4 text-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50"
          />

          <div className="absolute right-2 top-2 bottom-2 flex gap-2">
            {busy ? (
              <button
                type="button"
                onClick={stop}
                className="h-full px-6 bg-red-900/20 hover:bg-red-900/40 text-red-500 rounded-lg font-medium transition-colors border border-red-900/30"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="h-full px-6 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-bold transition-colors disabled:opacity-0 disabled:translate-x-4 transform duration-200"
              >
                Send
              </button>
            )}
          </div>
        </form>

        <div className="mt-4 flex justify-between text-xs text-slate-600 px-2">
          <button
            onClick={clear}
            disabled={busy || messages.length === 0}
            className="hover:text-slate-400 disabled:opacity-50 transition-colors"
          >
            New Game
          </button>
          <div className="flex items-center gap-4">
            <span>
              <span className="text-amber-600">MCP Standard</span>
              {" (no structured output)"}
            </span>
            <span className="text-cyan-400">{messages.length} messages</span>
          </div>
        </div>
      </div>
    </div>
  );
}
