/**
 * plugins/math.ts
 *
 * KaTeX math rendering plugin.
 *
 * This plugin renders LaTeX math expressions using KaTeX:
 * - Display math: $$...$$ or \[...\]
 * - Inline math: $...$ or \(...\)
 *
 * Dependencies: none (standalone, but typically used with markdown)
 */
import { marked } from 'marked'
import katex from 'katex'
import type { ProcessorPlugin } from './types'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'

// --- Math Rendering Utilities ---

/**
 * Render LaTeX math to HTML using KaTeX.
 */
function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
  } catch (e) {
    console.warn('KaTeX error:', e)
    return `<code class="katex-error">${latex}</code>`
  }
}

/**
 * Process content to render math expressions.
 *
 * Supports:
 * - Display math: $$...$$ or \[...\]
 * - Inline math: $...$ or \(...\)
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

// --- Math Markdown Processor ---

/**
 * Create the math markdown processor.
 *
 * Parses content with both math expressions (KaTeX) and markdown.
 */
function createMathMarkdownProcessor(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // First render math expressions
    const withMath = renderMathInContent(ctx.next)
    // Then parse markdown (math HTML will pass through)
    const html = marked.parse(withMath, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Math + Markdown plugin.
 *
 * Renders LaTeX math expressions and markdown to HTML.
 * Math is processed first, then markdown is applied.
 *
 * Supports:
 * - Display math: $$...$$ or \[...\]
 * - Inline math: $...$ or \(...\)
 *
 * @example
 * ```typescript
 * import { mathPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [mathPlugin]
 * })
 * ```
 */
export const mathPlugin: ProcessorPlugin = {
  name: 'math',
  description: 'KaTeX math rendering with markdown',
  settler: 'paragraph',
  processor: createMathMarkdownProcessor,
}

// --- Smart Math Processor (Code Fence Aware) ---

/**
 * Create a smart math processor that skips code fences.
 */
function createSmartMathProcessor(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // Inside code fences, just pass through raw
    if (ctx.meta?.inCodeFence) {
      yield* emit({ raw: ctx.chunk })
      return
    }

    // Outside code fences, render math + markdown
    const withMath = renderMathInContent(ctx.next)
    const html = marked.parse(withMath, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Smart Math plugin.
 *
 * Like mathPlugin but skips content inside code fences.
 * Use this when combining with syntax highlighting plugins.
 *
 * @example
 * ```typescript
 * import { smartMathPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [smartMathPlugin, shikiPlugin]
 * })
 * ```
 */
export const smartMathPlugin: ProcessorPlugin = {
  name: 'smart-math',
  description: 'KaTeX math rendering, skip code fences',
  settler: 'paragraph',
  processor: createSmartMathProcessor,
}
