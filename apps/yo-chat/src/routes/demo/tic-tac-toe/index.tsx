/**
 * /demo/tic-tac-toe - Tic-Tac-Toe Game Demo
 *
 * Demonstrates interactive game tools with the model as opponent:
 * - Model plays as X, user plays as O
 * - User can click cells OR type messages mid-game
 * - Emissions remain in chat history as snapshots
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect, useMemo } from 'react'
import { useChat, type ChatMessage, type ChatToolCall } from '@tanstack/framework/react/chat'
import type { Frame } from '@tanstack/framework/react/chat/pipeline'
import { tools } from '@/__generated__/tool-registry.gen'

export const Route = createFileRoute('/demo/tic-tac-toe/')({
  component: TicTacToeDemo,
})

/**
 * Extract HTML from a Frame by joining all block rendered content.
 */
function getFrameHtml(frame: Frame | undefined): string | null {
  if (!frame || !frame.blocks.length) return null
  return frame.blocks.map(b => b.rendered).join('')
}

/**
 * Debug panel showing raw message history
 */
function DebugPanel({ state, isOpen, onToggle }: { state: any; isOpen: boolean; onToggle: () => void }) {
  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="fixed bottom-4 right-4 px-3 py-2 bg-slate-800 text-slate-400 text-xs rounded-lg hover:bg-slate-700 z-50"
      >
        Show Debug
      </button>
    )
  }

  // Extract messages from state
  const rawMessages = state.messages || []
  
  // Format for display - show what would be sent to OpenAI
  const formatted = rawMessages.map((msg: any, i: number) => {
    const base: any = {
      index: i,
      role: msg.role,
    }
    
    // Content
    if (msg.content) {
      base.content = msg.content.length > 300 
        ? msg.content.slice(0, 300) + '...' 
        : msg.content
    }
    
    // Tool calls (assistant requesting tool use)
    if (msg.toolCalls?.length) {
      base.toolCalls = msg.toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        arguments: typeof tc.arguments === 'string' 
          ? tc.arguments 
          : JSON.stringify(tc.arguments),
      }))
    }
    
    // Tool result (response from tool)
    if (msg.role === 'tool') {
      base.toolCallId = msg.toolCallId
      base.result = typeof msg.content === 'string' && msg.content.length > 300
        ? msg.content.slice(0, 300) + '...'
        : msg.content
    }
    
    return base
  })

  return (
    <div className="fixed bottom-4 right-4 w-[600px] max-h-[70vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl z-50 flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-slate-700">
        <span className="text-sm font-bold text-slate-300">
          Debug: Raw Messages ({rawMessages.length})
        </span>
        <button onClick={onToggle} className="text-slate-500 hover:text-slate-300">
          Close
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono">
          {JSON.stringify(formatted, null, 2)}
        </pre>
      </div>
      <div className="p-2 border-t border-slate-700 flex gap-4">
        <button
          onClick={() => {
            console.log('=== FULL STATE ===')
            console.log(state)
            console.log('=== RAW MESSAGES ===')
            console.log(JSON.stringify(rawMessages, null, 2))
          }}
          className="text-xs text-cyan-500 hover:text-cyan-400"
        >
          Log to console
        </button>
        <button
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(rawMessages, null, 2))
          }}
          className="text-xs text-emerald-500 hover:text-emerald-400"
        >
          Copy JSON
        </button>
      </div>
    </div>
  )
}

/**
 * Renders a tool call with its inline emissions.
 */
function ToolCallBlock({ toolCall }: { toolCall: ChatToolCall }) {
  return (
    <div className="my-2">
      {toolCall.emissions.map((emission) => {
        const Component = emission.component
        if (!Component) return null

        return (
          <Component
            key={emission.id}
            {...emission.props}
            onRespond={emission.onRespond}
            disabled={emission.status !== 'pending'}
            response={emission.response}
          />
        )
      })}

      {toolCall.emissions.length === 0 && (toolCall.state === 'running' || toolCall.state === 'pending') && (
        <div className="text-xs text-slate-500 animate-pulse">
          Running {toolCall.name}...
        </div>
      )}

      {toolCall.state === 'error' && toolCall.error && (
        <div className="text-xs text-red-400">Error: {toolCall.error}</div>
      )}
    </div>
  )
}

/**
 * Renders a single message with its parts.
 */
function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  // Extract parts by type
  const textParts = message.parts.filter(p => p.type === 'text')
  const toolCallParts = message.parts.filter((p): p is ChatToolCall => p.type === 'tool-call')
  const hasTextContent = textParts.some(p => (p as { content?: string }).content)

  return (
    <div className={`mb-6 ${isUser ? 'text-right' : ''}`}>
      <div className={`inline-block max-w-[85%] ${isUser ? '' : 'w-full'}`}>
        <div
          className={`text-xs mb-1 font-bold tracking-wider uppercase ${
            isUser ? 'text-purple-400' : 'text-cyan-400'
          }`}
        >
          {isUser ? 'You (O)' : 'Model (X)'}
          {message.isStreaming && (
            <span className="ml-2 text-emerald-500 animate-pulse">thinking...</span>
          )}
        </div>

        <div
          className={`p-4 rounded-lg ${
            isUser
              ? 'bg-purple-950/30 border border-purple-900/50 text-purple-100'
              : 'bg-slate-800/50 text-slate-200'
          }`}
        >
          {/* Tool calls with emissions */}
          {toolCallParts.map((tc) => (
            <ToolCallBlock key={tc.id} toolCall={tc} />
          ))}

          {/* Text content */}
          {hasTextContent && (
            <div className="prose prose-invert prose-sm max-w-none leading-relaxed">
              {textParts.map((part, i) => {
                const html = getFrameHtml((part as { frame?: Frame }).frame)
                const content = (part as { content?: string }).content
                return (
                  <div key={part.id || i}>
                    {html ? (
                      <div dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      content
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {message.isStreaming && !hasTextContent && toolCallParts.length === 0 && (
            <span className="inline-block w-2 h-4 bg-cyan-500 animate-pulse" />
          )}
        </div>
      </div>
    </div>
  )
}

function TicTacToeDemo() {
  const {
    messages,
    streamingMessage,
    isStreaming,
    send,
    abort,
    reset,
    error,
    session,
  } = useChat({
    pipeline: 'markdown',
    tools: [tools.startTttGame, tools.tttMove, tools.tttWinner],
    systemPrompt: `You are playing tic-tac-toe against the user. You are X, the user is O.

CRITICAL: You MUST use the provided tools to play the game. Do NOT draw ASCII boards or describe moves in text.

To play:
1. When the user wants to play, call start_ttt_game with your opening move position (0-8)
2. After each user move, call ttt_move with the current board and your next move
3. When the game ends, call ttt_winner to announce the result

The tools will render an interactive board for the user. Never describe the board in text - always use the tools.

Board positions:
0 | 1 | 2
---------
3 | 4 | 5  
---------
6 | 7 | 8

You can chat with the user between moves, but ALL game actions must go through the tools.`,
  })

  const [input, setInput] = useState('')
  const [showDebug, setShowDebug] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Log state changes for debugging
  useEffect(() => {
    console.log('[TTT] State updated:', {
      messagesLength: session.state.messages.length,
      isStreaming: session.state.isStreaming,
      error: session.state.error,
    })
  }, [session.state])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingMessage?.parts.length])

  // Find any pending emission (for the chat input to respond to)
  const pendingEmission = useMemo(() => {
    for (const tracking of Object.values(session.toolEmissions)) {
      const pending = tracking.emissions.find((e) => e.status === 'pending')
      if (pending) {
        return { callId: tracking.callId, emission: pending }
      }
    }
    return null
  }, [session.toolEmissions])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    if (pendingEmission) {
      // Complete pending tool with user's message
      session.respondToEmission(pendingEmission.callId, pendingEmission.emission.id, {
        type: 'message',
        text: input.trim(),
      })
    } else {
      send(input.trim())
    }
    setInput('')
  }

  const placeholder = pendingEmission
    ? 'Type a message or click a cell above...'
    : isStreaming
      ? 'Waiting for response...'
      : "Type a message... (try: Let's play tic-tac-toe!)"

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-mono">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8 border-b border-slate-800 pb-4">
          <h1 className="text-3xl font-bold text-cyan-400 mb-2">Tic-Tac-Toe</h1>
          <p className="text-slate-400 text-sm">
            Play against the model. You're O, model is X. Click cells or type messages mid-game.
          </p>
        </div>

        {/* Messages */}
        <div className="bg-slate-900 rounded-xl p-6 min-h-[50vh] max-h-[60vh] overflow-y-auto mb-6 border border-slate-800">
          {messages.length === 0 && !isStreaming && (
            <div className="text-slate-600 text-center py-16">
              <div className="text-4xl mb-4">X | O</div>
              <p className="mb-4">Challenge the model to a game!</p>
              <button
                onClick={() => send("Let's play tic-tac-toe!")}
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
            placeholder={placeholder}
            disabled={isStreaming && !pendingEmission}
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
            New Game
          </button>
          <div className="flex items-center gap-4">
            {pendingEmission && <span className="text-amber-500">Your turn</span>}
            <span className="text-cyan-400">{messages.length} messages</span>
          </div>
        </div>
      </div>

      {/* Debug Panel */}
      <DebugPanel 
        state={session.state} 
        isOpen={showDebug} 
        onToggle={() => setShowDebug(!showDebug)} 
      />
    </div>
  )
}
