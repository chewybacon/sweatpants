/**
 * /demo/math - Math Assistant Demo
 *
 * Showcases the parts-based message model with:
 * - Reasoning parts rendered through the pipeline (collapsible)
 * - Tool calls with expandable details
 * - Text parts with markdown + math rendering
 * - Clean MessagePart component for all part types
 *
 * Uses pipeline: 'math' (markdown + KaTeX math rendering)
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useChat, type ChatMessage, type MessagePart, type TextPart, type ReasoningPart, type ToolCallPart } from '@sweatpants/framework/react/chat'
import { tools } from '@/__generated__/tool-registry.gen'
import 'katex/dist/katex.min.css'

export const Route = createFileRoute('/demo/math/')({
  component: MathAssistantDemo,
})

// =============================================================================
// Message Part Components
// =============================================================================

/**
 * Renders a reasoning/thinking part.
 * Collapsible by default, shows a preview when collapsed.
 */
function ReasoningPartView({ part }: { part: ReasoningPart }) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  // Get preview text (strip HTML for preview)
  const previewText = part.content.slice(0, 60).replace(/\n/g, ' ')
  
  return (
    <div className="group mb-3">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 text-left hover:bg-slate-800/30 rounded transition-colors p-1 -m-1"
      >
        <div className="flex items-center gap-2 text-xs text-purple-400/70">
          <span className="text-[10px] font-mono">{isExpanded ? 'v' : '>'}</span>
          <span className="font-semibold uppercase tracking-wider">
            Reasoning
          </span>
          {!isExpanded && (
            <span className="text-purple-400/50 truncate max-w-xs">
              {previewText}...
            </span>
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="mt-2 bg-purple-950/20 border border-purple-900/30 rounded-lg p-3">
          <div 
            className="prose prose-invert prose-sm prose-purple max-w-none text-purple-300/80 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: part.rendered }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Renders a tool call part with expandable arguments and results.
 */
function ToolCallPartView({ part }: { part: ToolCallPart }) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  const isComplete = part.state === 'complete'
  const isError = part.state === 'error'
  const isPending = part.state === 'pending' || part.state === 'running'
  
  // Format arguments for display
  const formatArgs = (args: unknown): string => {
    if (typeof args === 'string') {
      try {
        return JSON.stringify(JSON.parse(args), null, 2)
      } catch {
        return args
      }
    }
    return JSON.stringify(args, null, 2)
  }
  
  // Format result for display
  const formatResult = (result: unknown): string => {
    if (typeof result === 'string') return result
    return JSON.stringify(result, null, 2)
  }
  
  return (
    <div className="border border-slate-800 bg-slate-900/50 rounded overflow-hidden max-w-xl mb-3">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-800/50 transition-colors"
      >
        {/* Status Icon */}
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {isPending && (
            <div className="w-3 h-3 border-2 border-slate-600 border-t-cyan-500 rounded-full animate-spin" />
          )}
          {isComplete && <span className="text-green-500 text-xs">ok</span>}
          {isError && <span className="text-red-500 text-xs">err</span>}
        </div>

        {/* Tool Name */}
        <div className="font-mono text-xs text-slate-300 font-medium">
          {part.name}
        </div>

        {/* Args Preview */}
        <div className="flex-1 font-mono text-xs text-slate-500 truncate">
          {typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments)}
        </div>

        {/* Toggle Icon */}
        <div className="text-slate-600 text-[10px] font-mono">
          {isExpanded ? 'v' : '>'}
        </div>
      </button>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-slate-800 bg-slate-950 p-3 font-mono text-xs overflow-x-auto">
          <div className="text-slate-500 mb-1 uppercase tracking-wider text-[10px]">
            Arguments
          </div>
          <pre className="text-slate-300 mb-3 whitespace-pre-wrap">
            {formatArgs(part.arguments)}
          </pre>

          {isComplete && part.result !== undefined && (
            <>
              <div className="text-green-600 mb-1 uppercase tracking-wider text-[10px]">
                Result
              </div>
              <pre className="text-green-400 whitespace-pre-wrap">
                {String(formatResult(part.result))}
              </pre>
            </>
          )}

          {isError && part.error && (
            <>
              <div className="text-red-600 mb-1 uppercase tracking-wider text-[10px]">
                Error
              </div>
              <pre className="text-red-400 whitespace-pre-wrap">
                {part.error}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Renders a text content part with full pipeline rendering.
 */
function TextPartView({ part, isStreaming = false }: { part: TextPart; isStreaming?: boolean }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none leading-relaxed">
      <div dangerouslySetInnerHTML={{ __html: part.rendered }} />
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-cyan-500 ml-0.5 animate-pulse" />
      )}
    </div>
  )
}

/**
 * Universal MessagePart renderer - handles all part types in timeline order.
 */
function MessagePartView({ 
  part, 
  isStreaming = false,
  isActivePart = false,
}: { 
  part: MessagePart
  isStreaming?: boolean
  isActivePart?: boolean
}) {
  switch (part.type) {
    case 'reasoning':
      return <ReasoningPartView part={part} />
    case 'tool-call':
      return <ToolCallPartView part={part} />
    case 'text':
      return <TextPartView part={part} isStreaming={isStreaming && isActivePart} />
    default:
      return null
  }
}

// =============================================================================
// Message Component
// =============================================================================

/**
 * Renders a complete message with all its parts in timeline order.
 */
function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={`mb-8 ${isUser ? 'text-right' : ''}`}>
      <div className={`inline-block max-w-[85%] ${isUser ? '' : 'w-full'}`}>
        {/* Role label */}
        <div
          className={`text-xs mb-1 font-bold tracking-wider uppercase ${
            isUser ? 'text-cyan-500' : 'text-purple-500'
          }`}
        >
          {isUser ? 'You' : 'Assistant'}
          {message.isStreaming && (
            <span className="ml-2 text-emerald-500 animate-pulse">thinking...</span>
          )}
        </div>

        {/* Message content container */}
        <div
          className={`p-4 rounded-lg ${
            isUser
              ? 'bg-cyan-950/30 border border-cyan-900/50 text-cyan-100'
              : 'bg-slate-800/50 text-slate-200'
          }`}
        >
          {/* Render all parts in timeline order */}
          {message.parts.map((part, index) => (
            <MessagePartView 
              key={part.id} 
              part={part}
              isStreaming={message.isStreaming}
              isActivePart={index === message.parts.length - 1}
            />
          ))}
          
          {/* Show loading if streaming but no parts yet */}
          {message.isStreaming && message.parts.length === 0 && (
            <div className="text-slate-500 flex items-center gap-2">
              <div className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
              <span className="text-xs">Thinking...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Main Demo Component
// =============================================================================

function MathAssistantDemo() {
  const {
    messages,
    isStreaming,
    pipelineReady,
    send,
    abort,
    reset,
    error,
  } = useChat({
    // Use math pipeline: markdown + KaTeX
    pipeline: 'math',
    // Enable the calculator tool
    tools: [tools.calculator],
  })

  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
              Math Assistant
            </h1>
            <p className="text-slate-400 text-sm">
              Parts-based model with pipeline: 'math' (markdown + KaTeX)
            </p>
          </div>
          {/* Pipeline status */}
          <div className="text-xs">
            {pipelineReady ? (
              <span className="text-emerald-500">Pipeline ready</span>
            ) : (
              <span className="text-amber-500 animate-pulse">Loading KaTeX...</span>
            )}
          </div>
        </div>

        {/* Tool indicator */}
        <div className="mb-4 flex gap-2 justify-end">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
            calculator
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-900/30 text-purple-400 border border-purple-800">
            reasoning
          </span>
        </div>

        {/* Messages */}
        <div className="bg-slate-900 rounded-xl p-6 min-h-[60vh] max-h-[70vh] overflow-y-auto mb-6 shadow-inner border border-slate-800">
          {messages.length === 0 && !isStreaming && (
            <div className="text-slate-600 text-center py-20 flex flex-col items-center gap-4">
              <div className="text-4xl opacity-20">*</div>
              <p>Ask me a math question...</p>
              <div className="flex gap-2 text-xs flex-wrap justify-center">
                <button
                  onClick={() => setInput('Calculate sqrt(12345) * pi')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "sqrt(12345) * pi"
                </button>
                <button
                  onClick={() => setInput('Solve 2x + 5 = 15. Show your work.')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "Solve 2x + 5 = 15"
                </button>
                <button
                  onClick={() => setInput('What is the integral of x^2 from 0 to 1?')}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors"
                >
                  "integral of x^2"
                </button>
              </div>
            </div>
          )}

          {/* Render all messages */}
          {messages.map((msg) => (
            <Message key={msg.id} message={msg} />
          ))}

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
                : 'Type a math problem...'
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
                Solve
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
              <span className="text-emerald-600">pipeline:</span>
              {' math'}
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
