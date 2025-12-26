/**
 * /demo/effection/chat - Effection-Powered Chat Demo
 *
 * Demonstrates the dual buffer pattern for streaming:
 * - Settled content: Stable text (could be parsed/rendered)
 * - Pending content: Still streaming, shown as raw text with cursor
 *
 * Like double buffering in games - content accumulates in the back buffer
 * (pending) and gets promoted to the front buffer (settled) when safe.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useChatSession, dualBufferTransform, paragraph, markdown } from '@tanstack/framework/react/chat'

export const Route = createFileRoute('/demo/chat/')({
  component: EffectionChatDemo,
})

function EffectionChatDemo() {
  // Enhanced chat with markdown processing
  const { state, send, abort, reset } = useChatSession({
    transforms: [
      dualBufferTransform({
        settler: paragraph,
        processor: [markdown]
      })
    ]
  })
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages, state.buffer.settled, state.buffer.pending])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || state.isStreaming) return
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
              Dual Buffer Chat
            </h1>
            <p className="text-slate-400 text-sm">
              Double buffering pattern: settled vs pending content
            </p>
          </div>
        </div>

        {/* Messages */}
        <div className="bg-slate-900 rounded-xl p-6 min-h-[60vh] max-h-[70vh] overflow-y-auto mb-6 shadow-inner border border-slate-800">
           {state.messages.length === 0 && !state.isStreaming && (
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

           {state.messages.map((msg) => (
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
                </div>
                 <div
                   className={`p-4 rounded-lg ${msg.role === 'user'
                       ? 'bg-cyan-950/30 border border-cyan-900/50 text-cyan-100'
                       : 'bg-slate-800/50 text-slate-200'
                     }`}
                 >
                   <div
                     className="leading-relaxed prose prose-invert max-w-none"
                     dangerouslySetInnerHTML={{
                       __html: state.rendered[msg.id] || msg.content.replace(/\n/g, '<br>')
                     }}
                   />
                 </div>
              </div>
            </div>
          ))}

          {/* Streaming indicator with dual buffers */}
          {state.isStreaming && (
            <div className="mb-8 w-full">
              <div className="text-xs mb-1 font-bold tracking-wider uppercase text-purple-500">
                Assistant
              </div>
               <div className="bg-slate-800/50 p-4 rounded-lg">
                 <div className="leading-relaxed prose prose-invert max-w-none">
                   {/* Settled content - stable, could be processed */}
                   {state.buffer.settledHtml ? (
                     <span
                       className="text-emerald-300"
                       dangerouslySetInnerHTML={{ __html: state.buffer.settledHtml }}
                     />
                   ) : state.buffer.settled ? (
                     <span className="text-emerald-300">
                       {state.buffer.settled}
                     </span>
                   ) : null}
                   {/* Pending content - raw text with cursor */}
                   {state.buffer.pending && (
                     <span className="text-slate-400">
                       {state.buffer.pending}
                     </span>
                   )}
                   {/* Cursor */}
                   <span className="inline-block w-2 h-4 bg-cyan-500 ml-0.5 animate-pulse" />
                   {/* Fallback if no buffer content yet */}
                   {!state.buffer.settled && !state.buffer.pending && (
                     <span className="text-slate-500 flex items-center gap-2">
                       <span className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
                       Thinking...
                     </span>
                   )}
                 </div>
               </div>
            </div>
          )}

           {/* Error display */}
           {state.error && (
             <div className="p-4 bg-red-950/30 border border-red-900/50 rounded-lg text-red-400 my-4">
               <strong>Error:</strong> {state.error}
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
              state.isStreaming
                ? 'Waiting for response...'
                : 'Type a message...'
            }
            disabled={state.isStreaming}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-6 pr-32 py-4 text-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50"
          />

          <div className="absolute right-2 top-2 bottom-2 flex gap-2">
            {state.isStreaming ? (
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
             disabled={state.isStreaming || state.messages.length === 0}
             className="hover:text-slate-400 disabled:opacity-50 transition-colors"
           >
             Clear History
           </button>
           <div className="flex items-center gap-4">
             <span>
               <span className="text-emerald-600">settled</span>
               {' vs '}
               <span className="text-slate-500">pending</span>
               {' content'}
             </span>
             <span className="text-cyan-400">
               {state.messages.length} messages
             </span>
           </div>
         </div>
      </div>
    </div>
  )
}
