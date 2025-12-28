/**
 * plugins/mermaid.ts
 *
 * Mermaid diagram rendering plugin with progressive enhancement.
 *
 * This plugin provides:
 * - Quick pass: Instant syntax highlighting for mermaid code
 * - Full pass: Rendered SVG diagram when code fence closes
 *
 * ## Chaining Behavior
 *
 * This plugin is designed to work in a processor chain:
 * - If `ctx.html` is provided (from a previous processor like shiki), it will
 *   ONLY process mermaid code fences and pass through everything else
 * - If no previous HTML, it handles markdown + all code fences (standalone mode)
 *
 * Dependencies: none (standalone) or after shikiPlugin (for full highlighting)
 * Settler: codeFence (required for language detection)
 */
import { marked } from 'marked'
import type { Operation } from 'effection'
import type { ProcessorPlugin } from './types'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'
import type { CodeFenceMeta } from '../settlers/code-fence'
import {
  renderMermaid,
  preloadMermaid,
  isMermaidReady,
} from '../mermaid/loader'

// --- Quick Highlighting for Mermaid Syntax ---

const MERMAID_PATTERNS: Array<{ pattern: RegExp; className: string }> = [
  // Diagram type keywords
  { pattern: /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart|block-beta)\b/g, className: 'keyword' },
  // Direction keywords
  { pattern: /\b(TD|TB|BT|RL|LR)\b/g, className: 'keyword' },
  // Arrows and connections
  { pattern: /(-->|--o|--x|<-->|---|\.\.\.>|===|==>|-.->|-\.-)/g, className: 'operator' },
  // Node shapes
  { pattern: /(\[\[.*?\]\]|\[\(.*?\)\]|\[\{.*?\}\]|\[\/.*?\/\]|\[\\.*?\\\])/g, className: 'string' },
  { pattern: /(\[.*?\])/g, className: 'string' },
  { pattern: /(\(.*?\))/g, className: 'string' },
  { pattern: /(\{.*?\})/g, className: 'string' },
  // Subgraph
  { pattern: /\b(subgraph|end)\b/g, className: 'keyword' },
  // Participants, actors
  { pattern: /\b(participant|actor|activate|deactivate|Note|note|over|loop|alt|else|opt|par|and|rect|critical|break)\b/g, className: 'keyword' },
  // Styling
  { pattern: /\b(style|classDef|class|linkStyle)\b/g, className: 'keyword' },
  // Comments
  { pattern: /(%%.*$)/gm, className: 'comment' },
  // Labels
  { pattern: /(\|.*?\|)/g, className: 'string' },
]

/**
 * Apply quick regex-based highlighting to mermaid code.
 */
function quickHighlightMermaid(code: string): string {
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const combinedParts: string[] = []
  const patternInfo: Array<{ className: string; groupIndex: number }> = []
  let groupCount = 0

  for (const { pattern, className } of MERMAID_PATTERNS) {
    combinedParts.push(pattern.source)
    patternInfo.push({ className, groupIndex: groupCount + 1 })
    const groupsInPattern = (pattern.source.match(/\((?!\?)/g) || []).length
    groupCount += groupsInPattern
  }

  const combinedRegex = new RegExp(combinedParts.join('|'), 'gm')

  return escaped.replace(combinedRegex, (...args) => {
    const fullMatch = args[0]
    const captureGroups = args.slice(1, -2)

    for (const { className, groupIndex } of patternInfo) {
      const captured = captureGroups[groupIndex - 1]
      if (captured !== undefined) {
        return `<span class="ql-${className}">${captured}</span>`
      }
    }

    return fullMatch
  })
}

/**
 * Basic HTML escaping for non-mermaid code.
 */
function escapeHtml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Wrap code in a pre/code block for display.
 */
function wrapCodeBlock(html: string, language: string, isQuick: boolean): string {
  const langClass = language ? ` language-${language}` : ''
  const quickClass = isQuick ? ' quick-highlight' : ''
  return `<pre class="code-block${quickClass}"><code class="${langClass}">${html}</code></pre>`
}

// --- Mermaid Processor ---

interface MermaidBlockState {
  lines: string[]
  quickHtml: string
}

/**
 * Create the Mermaid processor.
 *
 * This processor operates in two modes:
 *
 * 1. **Chained mode** (ctx.html present): Only handles mermaid code fences.
 *    For everything else, passes through the HTML from the previous processor.
 *
 * 2. **Standalone mode** (no ctx.html): Handles markdown + all code fences.
 *    Non-mermaid code gets basic escaping.
 */
function createMermaidProcessor(): Processor {
  // State for mermaid blocks (used in both modes)
  let mermaidBlock: MermaidBlockState | null = null

  // State for standalone mode only
  let standaloneMarkdownBuffer = ''
  let standaloneOutputHtml = ''

  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const meta = ctx.meta as CodeFenceMeta | undefined
    const hasUpstreamHtml = ctx.html !== undefined

    // --- CHAINED MODE: Previous processor provided HTML ---
    if (hasUpstreamHtml) {
      // Check if we're in a mermaid code fence
      const isMermaidFence = meta?.inCodeFence && meta.language?.toLowerCase() === 'mermaid'

      if (!isMermaidFence) {
        // Not mermaid - pass through upstream HTML unchanged
        yield* emit({
          raw: ctx.chunk,
          ...(ctx.html !== undefined && { html: ctx.html }),
          pass: 'quick',
        })
        return
      }

      // Mermaid fence start
      if (meta.fenceStart) {
        mermaidBlock = { lines: [], quickHtml: '' }
        // Pass through upstream HTML (which shows the fence opening)
        yield* emit({
          raw: ctx.chunk,
          ...(ctx.html !== undefined && { html: ctx.html }),
          pass: 'quick',
        })
        return
      }

      // Mermaid fence end - render the diagram
      if (meta.fenceEnd && mermaidBlock) {
        const fullCode = meta.codeContent || mermaidBlock.lines.join('')

        // Emit quick version first (upstream HTML with our quick highlight)
        const quickHtml = wrapCodeBlock(mermaidBlock.quickHtml, 'mermaid', true)
        // Replace the mermaid code block in upstream HTML with our quick version
        const quickOutput = replaceMermaidBlock(ctx.html!, quickHtml)
        yield* emit({
          raw: ctx.chunk,
          html: quickOutput,
          pass: 'quick',
        })

        // Render mermaid diagram
        const result = yield* renderMermaid(fullCode)
        const finalBlock = result.success ? result.svg : quickHtml
        const finalOutput = replaceMermaidBlock(ctx.html!, finalBlock)

        yield* emit({
          raw: ctx.chunk,
          html: finalOutput,
          pass: 'full',
        })

        mermaidBlock = null
        return
      }

      // Regular mermaid code line
      if (mermaidBlock) {
        mermaidBlock.lines.push(ctx.chunk)
        mermaidBlock.quickHtml += quickHighlightMermaid(ctx.chunk)

        // Show progressive quick highlight
        const quickHtml = wrapCodeBlock(mermaidBlock.quickHtml, 'mermaid', true)
        const quickOutput = replaceMermaidBlock(ctx.html!, quickHtml)
        yield* emit({
          raw: ctx.chunk,
          html: quickOutput,
          pass: 'quick',
        })
      }
      return
    }

    // --- STANDALONE MODE: No upstream HTML, handle everything ---

    // Outside code fence: Accumulate for markdown
    if (!meta?.inCodeFence) {
      standaloneMarkdownBuffer += ctx.chunk
      const parsedMarkdown = marked.parse(standaloneMarkdownBuffer, { async: false }) as string
      const fullHtml = standaloneOutputHtml + parsedMarkdown
      yield* emit({
        raw: ctx.next,
        html: fullHtml,
        pass: 'quick',
      })
      return
    }

    const isMermaid = meta.language?.toLowerCase() === 'mermaid'

    // Fence start: Initialize block state
    if (meta.fenceStart) {
      if (standaloneMarkdownBuffer) {
        standaloneOutputHtml += marked.parse(standaloneMarkdownBuffer, { async: false }) as string
        standaloneMarkdownBuffer = ''
      }

      if (isMermaid) {
        mermaidBlock = { lines: [], quickHtml: '' }
      }
      return
    }

    // Fence end: Render the full block
    if (meta.fenceEnd) {
      const fullCode = meta.codeContent || (mermaidBlock?.lines.join('') ?? '')
      const language = meta.language || 'text'

      if (isMermaid && mermaidBlock) {
        // Emit quick version first
        const quickHtml = mermaidBlock.quickHtml
        const wrappedQuick = wrapCodeBlock(quickHtml, language, true)
        yield* emit({
          raw: ctx.next,
          html: standaloneOutputHtml + wrappedQuick,
          pass: 'quick',
        })

        // Render mermaid diagram
        const result = yield* renderMermaid(fullCode)
        if (result.success) {
          standaloneOutputHtml += result.svg
        } else {
          standaloneOutputHtml += wrappedQuick
        }

        yield* emit({
          raw: ctx.next,
          html: standaloneOutputHtml,
          pass: 'full',
        })

        mermaidBlock = null
      } else {
        // Non-mermaid in standalone mode: just escape
        const escaped = escapeHtml(fullCode)
        const wrappedQuick = wrapCodeBlock(escaped, language, true)
        standaloneOutputHtml += wrappedQuick

        yield* emit({
          raw: ctx.next,
          html: standaloneOutputHtml,
          pass: 'quick',
        })
      }
      return
    }

    // Regular code line
    if (isMermaid && mermaidBlock) {
      mermaidBlock.lines.push(ctx.chunk)
      mermaidBlock.quickHtml += quickHighlightMermaid(ctx.chunk)

      const wrappedQuick = wrapCodeBlock(mermaidBlock.quickHtml, 'mermaid', true)
      yield* emit({
        raw: ctx.next,
        html: standaloneOutputHtml + wrappedQuick,
        pass: 'quick',
      })
    } else {
      // Non-mermaid code line in standalone mode - accumulate
      // (will be processed at fence end)
    }
  }
}

/**
 * Replace the last mermaid code block in HTML with new content.
 *
 * This finds the last <pre> block with language-mermaid and replaces it.
 * Used in chained mode to swap upstream processor's mermaid block with our rendered version.
 */
function replaceMermaidBlock(html: string, replacement: string): string {
  // Find the last mermaid code block (could be shiki format or generic)
  // Shiki format: <pre class="shiki..."><code>...</code></pre>
  // Generic format: <pre...class="...language-mermaid...">...</pre>

  // Try to find and replace the last code block (the one being streamed)
  // The upstream processor would have just added this block

  // Simple approach: find the last <pre> tag and replace everything from there
  const lastPreIndex = html.lastIndexOf('<pre')
  if (lastPreIndex === -1) {
    // No pre tag found, just append
    return html + replacement
  }

  // Find the closing </pre> or </code></pre>
  const afterPre = html.slice(lastPreIndex)
  const closePreMatch = afterPre.match(/<\/pre>/)
  if (!closePreMatch) {
    // Unclosed pre tag, replace from lastPreIndex
    return html.slice(0, lastPreIndex) + replacement
  }

  const closePreIndex = lastPreIndex + closePreMatch.index! + '</pre>'.length
  return html.slice(0, lastPreIndex) + replacement + html.slice(closePreIndex)
}

/**
 * Mermaid diagram rendering plugin.
 *
 * Provides progressive diagram rendering:
 * 1. Quick pass: Mermaid syntax highlighting while typing
 * 2. Full pass: Rendered SVG diagram when code fence closes
 *
 * For non-mermaid code blocks, this plugin just escapes HTML.
 * Add shikiPlugin for full syntax highlighting of other languages.
 *
 * @example
 * ```typescript
 * import { mermaidPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * // Mermaid only (basic escaping for other code)
 * useChat({
 *   plugins: [mermaidPlugin]
 * })
 *
 * // Mermaid + full syntax highlighting
 * useChat({
 *   plugins: [shikiPlugin, mermaidPlugin]
 * })
 * ```
 */
export const mermaidPlugin: ProcessorPlugin = {
  name: 'mermaid',
  description: 'Progressive mermaid diagram rendering',
  settler: 'codeFence',

  *preload(): Operation<void> {
    yield* preloadMermaid()
  },

  isReady: isMermaidReady,

  processor: createMermaidProcessor,
}
