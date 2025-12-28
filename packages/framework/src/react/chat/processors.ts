/**
 * processors.ts
 *
 * Built-in processors for enriching settled content.
 *
 * Processors are Effection Operations that transform settled content.
 * They can:
 * - Do async work (yield* sleep(), yield* call())
 * - Emit multiple times for progressive enhancement (quick pass → full pass)
 * - Access settler metadata for context-aware processing (e.g., code fence info)
 *
 * ## Usage
 *
 * ```typescript
 * import { markdown, passthrough, syntaxHighlight } from './processors'
 *
 * // Pass factory functions, NOT called instances
 * dualBufferTransform({
 *   settler: paragraph,    // factory reference
 *   processor: markdown,   // factory reference (not markdown())
 * })
 * 
 * // Progressive syntax highlighting
 * dualBufferTransform({
 *   settler: codeFence,
 *   processor: syntaxHighlight,
 * })
 * ```
 */
import type { Operation } from 'effection'
import { marked } from 'marked'
import katex from 'katex'
import type { Processor, ProcessorEmit, ProcessorContext, SyncProcessor, ProcessorFactory } from './types'

// --- Math Rendering Utilities ---

/**
 * Render LaTeX math to HTML using KaTeX.
 * 
 * @param latex - The LaTeX expression
 * @param displayMode - If true, render in display mode (centered, larger)
 * @returns HTML string
 */
function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
  } catch (e) {
    // Return the original LaTeX wrapped in a code block on error
    console.warn('KaTeX error:', e)
    return `<code class="katex-error">${latex}</code>`
  }
}

/**
 * Process content to render math expressions.
 * 
 * Supports:
 * - Display math: $$...$$, \[...\]
 * - Inline math: $...$, \(...\)
 * 
 * @param content - The content to process
 * @returns Content with math expressions rendered to HTML
 */
function renderMathInContent(content: string): string {
  // Display math: $$...$$ or \[...\]
  content = content.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
    return renderMath(latex.trim(), true)
  })
  content = content.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) => {
    return renderMath(latex.trim(), true)
  })
  
  // Inline math: $...$ or \(...\)
  // Be careful not to match currency ($50) - require at least one non-digit
  content = content.replace(/\$([^\$\n]+?)\$/g, (match, latex) => {
    // Skip if it looks like currency (just digits and common currency chars)
    if (/^[\d,.\s]+$/.test(latex)) {
      return match
    }
    return renderMath(latex.trim(), false)
  })
  content = content.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) => {
    return renderMath(latex.trim(), false)
  })
  
  return content
}

// --- Built-in Processors (Operation-based) ---

/**
 * Passthrough processor - no enrichment.
 *
 * Returns the raw content with no additional processing.
 * This is the default processor.
 */
export function passthrough(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    yield* emit({ raw: ctx.chunk })
  }
}

/**
 * Markdown processor - parse settled content to HTML.
 *
 * Parses the full accumulated content (not just the chunk) to HTML.
 * This ensures proper parsing of multi-paragraph markdown.
 */
export function markdown(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // marked.parse is synchronous when async option is not set
    const html = marked.parse(ctx.next, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Incremental markdown processor - parse only the new chunk.
 *
 * Faster but may not handle cross-paragraph markdown correctly.
 * Use when you know each settled chunk is self-contained.
 */
export function incrementalMarkdown(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const html = marked.parse(ctx.chunk, { async: false }) as string
    yield* emit({
      raw: ctx.chunk,
      html,
    })
  }
}

/**
 * Smart markdown processor - context-aware markdown parsing.
 * 
 * This processor uses settler metadata to make smart decisions:
 * - Inside code fences: skips markdown parsing (code is handled separately)
 * - Outside code fences: parses as normal markdown
 * 
 * Best used with the codeFence() settler.
 */
export function smartMarkdown(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // Inside code fences, just pass through raw
    if (ctx.meta?.inCodeFence) {
      yield* emit({ raw: ctx.chunk })
      return
    }

    // Outside code fences, parse as markdown
    const html = marked.parse(ctx.next, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Quick regex-based syntax highlighting.
 * 
 * Fast but limited - only highlights common keywords.
 * Used for the "quick pass" in progressive enhancement.
 */
function quickHighlight(code: string, _language?: string): string {
  // Common keywords across multiple languages
  return code.replace(
    /\b(def|return|if|else|elif|for|while|in|class|import|from|as|with|try|except|finally|raise|yield|lambda|and|or|not|is|None|True|False|const|let|var|function|async|await|export|default)\b/g,
    '<span class="kw">$1</span>'
  )
}

/**
 * Syntax highlight processor - progressive enhancement.
 * 
 * This processor demonstrates the progressive enhancement pattern:
 * 1. Quick pass: Instant regex-based highlighting
 * 2. Full pass: Proper highlighting (simulated async Shiki)
 * 
 * The quick pass renders immediately, then the full pass replaces it
 * once the async work completes.
 * 
 * Best used with the codeFence() settler which provides metadata.
 */
export function syntaxHighlight(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // If not in code fence, just pass through
    if (!ctx.meta?.inCodeFence) {
      yield* emit({ raw: ctx.chunk, pass: 'quick' })
      return
    }

    // Quick pass - instant regex highlighting
    const quickHtml = quickHighlight(ctx.chunk, ctx.meta.language)
    yield* emit({ raw: ctx.chunk, html: quickHtml, pass: 'quick' })

    // Full pass - simulate async Shiki highlighting
    // In a real implementation, this would call Shiki:
    //   const html = yield* call(() => shiki.codeToHtml(ctx.chunk, { lang: ctx.meta?.language }))
    // For now, we simulate with a more detailed regex highlight
    const fullHtml = ctx.chunk
      .replace(/\b(def|class|function)\b/g, '<span class="keyword">$1</span>')
      .replace(/\b(return|if|else|for|while|in)\b/g, '<span class="control">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="number">$1</span>')
      .replace(/'([^']*)'/g, '<span class="string">\'$1\'</span>')
      .replace(/"([^"]*)"/g, '<span class="string">"$1"</span>')

    yield* emit({ raw: ctx.chunk, html: fullHtml, pass: 'full' })
  }
}

// --- Reveal Hint Processors ---
// 
// These processors emit reveal hints that React can use to animate content.
// They do NOT block the pipeline - animation happens in the UI layer.

/**
 * Character-by-character reveal hint processor.
 *
 * Emits a reveal hint suggesting React should animate the content
 * character-by-character. The actual animation is handled by React,
 * not by blocking the stream pipeline.
 *
 * @param durationMs - Suggested total duration for the reveal animation (default: calculated from chunk length)
 * @param charDelayMs - Delay per character in ms, used to calculate duration if not specified (default: 30)
 *
 * @example
 * ```tsx
 * // In your React component, use the revealHint to animate:
 * if (state.buffer.renderable?.revealHint?.type === 'character') {
 *   // Animate characters one by one
 *   const duration = state.buffer.renderable.revealHint.duration
 *   // ... apply CSS animation or JS-based reveal
 * }
 * ```
 */
export function characterReveal(options: { durationMs?: number, charDelayMs?: number } = {}): ProcessorFactory {
  const { charDelayMs = 30 } = options
  
  return () => function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
    if (!ctx.chunk) return

    // Calculate duration based on chunk length if not specified
    const duration = options.durationMs ?? (ctx.chunk.length * charDelayMs)

    yield* emit({
      raw: ctx.chunk,
      revealHint: {
        type: 'character' as const,
        duration,
        isComplete: false,
      },
    })
  }
}

/**
 * Word-by-word reveal hint processor.
 *
 * Emits a reveal hint suggesting React should animate the content
 * word-by-word. The actual animation is handled by React.
 *
 * @param durationMs - Suggested total duration for the reveal animation
 * @param wordDelayMs - Delay per word in ms, used to calculate duration if not specified (default: 100)
 */
export function wordReveal(options: { durationMs?: number, wordDelayMs?: number } = {}): ProcessorFactory {
  const { wordDelayMs = 100 } = options
  
  return () => function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
    if (!ctx.chunk) return

    const wordCount = ctx.chunk.split(/\s+/).filter(w => w.trim()).length
    const duration = options.durationMs ?? (wordCount * wordDelayMs)

    yield* emit({
      raw: ctx.chunk,
      revealHint: {
        type: 'word' as const,
        duration,
        isComplete: false,
      },
    })
  }
}

/**
 * Line-by-line reveal hint processor.
 *
 * Emits a reveal hint suggesting React should animate the content
 * line-by-line. Useful for code blocks.
 *
 * @param lineDelayMs - Delay per line in ms (default: 50)
 */
export function lineReveal(options: { durationMs?: number, lineDelayMs?: number } = {}): ProcessorFactory {
  const { lineDelayMs = 50 } = options
  
  return () => function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
    if (!ctx.chunk) return

    const lineCount = ctx.chunk.split('\n').length
    const duration = options.durationMs ?? (lineCount * lineDelayMs)

    yield* emit({
      raw: ctx.chunk,
      revealHint: {
        type: 'line' as const,
        duration,
        isComplete: false,
      },
    })
  }
}

/**
 * Instant reveal processor (no animation hint).
 *
 * Emits content with a hint that it should appear instantly.
 * Use this when you don't want any reveal animation.
 */
export function instantReveal(): ProcessorFactory {
  return () => function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
    if (!ctx.chunk) return

    yield* emit({
      raw: ctx.chunk,
      revealHint: {
        type: 'instant' as const,
        isComplete: true,
      },
    })
  }
}

/**
 * Wrap a legacy sync processor to work with the new Operation-based API.
 *
 * @deprecated New code should use the Operation-based API directly.
 */
export function fromSync(syncProcessor: SyncProcessor): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const result = syncProcessor(ctx)
    yield* emit(result)
  }
}

/**
 * Default processor factory: passthrough (no enrichment).
 * 
 * This is the factory function used by dualBufferTransform when no processor is specified.
 */
export const defaultProcessorFactory = passthrough

// --- Message Renderers (for completed messages) ---

import type { MessageRenderer } from './types'

/**
 * Markdown message renderer.
 * 
 * Renders message content to HTML using marked.
 * Use this with the `renderer` option in useChatSession.
 * 
 * @example
 * ```typescript
 * useChatSession({
 *   renderer: markdownRenderer(),
 * })
 * ```
 */
export function markdownRenderer(): MessageRenderer {
  return (content: string) => {
    return marked.parse(content, { async: false }) as string
  }
}

/**
 * Math-aware markdown message renderer.
 * 
 * Renders message content to HTML with both markdown and LaTeX math support.
 * Uses marked for markdown and KaTeX for math expressions.
 * 
 * Supports:
 * - Display math: $$...$$ or \[...\]
 * - Inline math: $...$ or \(...\)
 * 
 * @example
 * ```typescript
 * useChatSession({
 *   renderer: mathRenderer(),
 * })
 * ```
 */
export function mathRenderer(): MessageRenderer {
  return (content: string) => {
    // First render math expressions
    const withMath = renderMathInContent(content)
    // Then parse markdown (math HTML will pass through)
    return marked.parse(withMath, { async: false }) as string
  }
}

/**
 * Math processor - parse settled content to HTML with math support.
 *
 * Like markdown() but also renders LaTeX math expressions using KaTeX.
 * Parses the full accumulated content (not just the chunk) to HTML.
 */
export function mathMarkdown(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // First render math expressions
    const withMath = renderMathInContent(ctx.next)
    // Then parse markdown
    const html = marked.parse(withMath, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

// --- Processor Utilities ---

/**
 * Debounce processor - batches rapid emissions for expensive operations.
 *
 * This is useful for expensive processors like syntax highlighting.
 * Instead of processing every chunk immediately, it batches rapid updates
 * and only processes the final accumulated state.
 *
 * Note: This uses a simple time-based debounce. For RAF-based throttling
 * in React, use the throttleHint metadata and handle it in your component.
 *
 * @param processor - The processor to wrap
 * @param delayMs - Debounce delay in milliseconds (default: 16 for ~60fps)
 */
export function debounceProcessor(
  processor: ProcessorFactory,
  delayMs: number = 16
): ProcessorFactory {
  return () => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    return function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      // If there's a pending timeout, skip processing (debounce)
      if (timeoutId !== null) {
        return
      }

      // Set up a new timeout
      timeoutId = setTimeout(() => {
        timeoutId = null
      }, delayMs)

      // Process with a throttle hint
      const innerProcessor = processor()
      yield* innerProcessor(ctx, function* (output) {
        yield* emit({
          ...output,
          throttleHint: {
            debounced: true,
            delayMs,
          },
        })
      })
    }
  }
}

/**
 * Batch processor - collects chunks and processes them together.
 *
 * Useful when you want to process multiple chunks as a single unit.
 * The batch is processed when:
 * - The batch size is reached
 * - A timeout occurs
 * - The stream ends (flush)
 *
 * @param processor - The processor to wrap
 * @param options - Batching options
 */
export function batchProcessor(
  processor: ProcessorFactory,
  options: {
    /** Maximum batch size in characters (default: 500) */
    maxSize?: number
    /** Maximum batch time in ms (default: 100) */
    maxTimeMs?: number
  } = {}
): ProcessorFactory {
  const { maxSize = 500, maxTimeMs = 100 } = options

  return () => {
    let batchContent = ''
    let batchStartTime = Date.now()

    return function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      batchContent += ctx.chunk
      const elapsed = Date.now() - batchStartTime

      // Check if we should flush the batch
      const shouldFlush = batchContent.length >= maxSize || elapsed >= maxTimeMs

      if (shouldFlush && batchContent) {
        const innerProcessor = processor()
        const batchCtx: ProcessorContext = {
          ...ctx,
          chunk: batchContent,
          // Keep accumulated/next from original context
        }

        yield* innerProcessor(batchCtx, emit)

        // Reset batch
        batchContent = ''
        batchStartTime = Date.now()
      }
    }
  }
}

/**
 * With throttle hint - adds throttle metadata to processor output.
 *
 * This doesn't actually throttle the processor, but adds metadata
 * that React can use to implement client-side throttling (e.g., RAF).
 *
 * @param processor - The processor to wrap
 * @param hint - Throttle hint configuration
 */
export function withThrottleHint(
  processor: ProcessorFactory,
  hint: {
    /** Suggested throttle strategy */
    strategy: 'raf' | 'debounce' | 'none'
    /** For debounce strategy, the delay in ms */
    delayMs?: number
  }
): ProcessorFactory {
  return () => {
    const innerProcessor = processor()

    return function* (ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      yield* innerProcessor(ctx, function* (output) {
        yield* emit({
          ...output,
          throttleHint: hint,
        })
      })
    }
  }
}

