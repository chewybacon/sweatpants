/**
 * /demo/chat - Plugin-Based Chat Demo
 *
 * Demonstrates the new plugin-based rendering engine:
 * - Plugins are resolved in dependency order (DAG)
 * - Settler is negotiated (most specific wins)
 * - Assets are preloaded eagerly on mount
 *
 * Uses the high-level useChat hook with plugin configuration.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useChat } from '@tanstack/framework/react/chat'
import { shikiPlugin, mermaidPlugin } from '@tanstack/framework/react/chat/plugins'

export const Route = createFileRoute('/demo/chat/')({
  component: PluginChatDemo,
})

function PluginChatDemo() {
  // High-level useChat hook with plugin-based configuration
  const { 
    messages, 
    streamingMessage,
    isStreaming,
    pluginsReady,
    send, 
    abort, 
    reset,
    error,
  } = useChat({
    // Plugins handle markdown, syntax highlighting, and diagrams
    // - shikiPlugin: progressive syntax highlighting (codeFence settler)
    // - mermaidPlugin: mermaid diagram rendering (codeFence settler)
    plugins: [shikiPlugin, mermaidPlugin]
  })
  
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingMessage?.content])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isStreaming) return
    send(input.trim())
    setInput('')
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-mono">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-3xl font-bold text-cyan-400 mb-2">
              Plugin-Based Chat
            </h1>
            <p className="text-slate-400 text-sm">
              Using useChat with plugins: shikiPlugin + mermaidPlugin
            </p>
          </div>
          {/* Plugin loading indicator */}
          <div className="text-xs">
            {pluginsReady ? (
              <span className="text-emerald-500">Plugins ready</span>
            ) : (
              <span className="text-amber-500 animate-pulse">Loading plugins...</span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="bg-slate-900 rounded-xl p-6 min-h-[60vh] max-h-[70vh] overflow-y-auto mb-6 shadow-inner border border-slate-800">
          {messages.length === 0 && !isStreaming && (
            <div className="text-slate-600 text-center py-20 flex flex-col items-center gap-4">
              <div className="text-4xl opacity-20">~</div>
              <p>Send a message to start chatting</p>
              <div className="flex gap-2 text-xs flex-wrap justify-center">
                <button
                  onClick={() => setInput('Tell me about quantum computing')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "quantum computing"
                </button>
                <button
                  onClick={() => setInput('Write a haiku about code')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "haiku about code"
                </button>
                <button
                  onClick={() => setInput('Explain how React hooks work')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "React hooks"
                </button>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`mb-8 ${msg.role === 'user' ? 'text-right' : ''}`}
            >
              <div
                className={`inline-block max-w-[85%] ${msg.role === 'user' ? '' : 'w-full'
                  }`}
              >
                <div
                  className={`text-xs mb-1 font-bold tracking-wider uppercase ${msg.role === 'user' ? 'text-cyan-500' : 'text-purple-500'
                    }`}
                >
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                  {msg.isStreaming && (
                    <span className="ml-2 text-emerald-500 animate-pulse">streaming...</span>
                  )}
                </div>
                <div
                  className={`p-4 rounded-lg ${msg.role === 'user'
                    ? 'bg-cyan-950/30 border border-cyan-900/50 text-cyan-100'
                    : 'bg-slate-800/50 text-slate-200'
                    }`}
                >
                  <div className="prose prose-invert prose-sm max-w-none leading-relaxed">
                    {msg.html ? (
                      <div dangerouslySetInnerHTML={{ __html: msg.html }} />
                    ) : (
                      msg.content
                    )}
                    {/* Cursor for streaming messages */}
                    {msg.isStreaming && (
                      <span className="inline-block w-2 h-4 bg-cyan-500 ml-0.5 animate-pulse" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Show delta info if streaming (debug) */}
          {streamingMessage?.delta && (
            <div className="text-xs text-slate-600 mt-2">
              Delta: +{streamingMessage.delta.added.length} chars at offset {streamingMessage.delta.startOffset}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="p-4 bg-red-950/30 border border-red-900/50 rounded-lg text-red-400 my-4">
              <strong>Error:</strong> {error}
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
              isStreaming
                ? 'Waiting for response...'
                : 'Type a message...'
            }
            disabled={isStreaming}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-6 pr-32 py-4 text-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50"
          />

          <div className="absolute right-2 top-2 bottom-2 flex gap-2">
            {isStreaming ? (
              <button
                type="button"
                onClick={abort}
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
            onClick={reset}
            disabled={isStreaming || messages.length === 0}
            className="hover:text-slate-400 disabled:opacity-50 transition-colors"
          >
            Clear History
          </button>
          <div className="flex items-center gap-4">
            <span>
              <span className="text-emerald-600">plugins:</span>
              {' shiki + mermaid'}
            </span>
            <span className="text-cyan-400">
              {messages.length} messages
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
