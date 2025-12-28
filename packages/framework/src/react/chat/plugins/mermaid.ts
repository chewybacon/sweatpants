/**
 * plugins/mermaid.ts
 *
 * Mermaid diagram rendering plugin with progressive enhancement.
 *
 * This plugin provides:
 * - Quick pass: Instant syntax highlighting for mermaid code
 * - Full pass: Rendered SVG diagram when code fence closes
 *
 * IMPORTANT: This plugin is DECOUPLED from shiki. For non-mermaid code blocks,
 * it falls back to basic escaping. If you want full syntax highlighting for
 * other languages, add shikiPlugin to your plugin list.
 *
 * Dependencies: none (standalone)
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

interface CodeBlockState {
  lines: string[]
  language: string
  quickHtml: string
  isMermaid: boolean
}

/**
 * Create the Mermaid processor.
 */
function createMermaidProcessor(): Processor {
  let currentBlock: CodeBlockState | null = null
  let markdownBuffer = ''
  let outputHtml = ''

  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const meta = ctx.meta as CodeFenceMeta | undefined

    // Outside code fence: Accumulate for markdown
    if (!meta?.inCodeFence) {
      markdownBuffer += ctx.chunk
      const parsedMarkdown = marked.parse(markdownBuffer, { async: false }) as string
      const fullHtml = outputHtml + parsedMarkdown
      yield* emit({
        raw: ctx.next,
        html: fullHtml,
        pass: 'quick',
      })
      return
    }

    // Fence start: Initialize block state
    if (meta.fenceStart) {
      if (markdownBuffer) {
        outputHtml += marked.parse(markdownBuffer, { async: false }) as string
        markdownBuffer = ''
      }

      const language = meta.language || 'text'
      currentBlock = {
        lines: [],
        language,
        quickHtml: '',
        isMermaid: language.toLowerCase() === 'mermaid',
      }
      return
    }

    // Fence end: Render the full block
    if (meta.fenceEnd && currentBlock) {
      const fullCode = meta.codeContent || currentBlock.lines.join('')
      const language = currentBlock.language

      // Emit quick version first
      const quickHtml = currentBlock.quickHtml
      const wrappedQuick = wrapCodeBlock(quickHtml, language, true)
      yield* emit({
        raw: ctx.next,
        html: outputHtml + wrappedQuick,
        pass: 'quick',
      })

      if (currentBlock.isMermaid) {
        // Render mermaid diagram
        const result = yield* renderMermaid(fullCode)
        if (result.success) {
          outputHtml += result.svg
        } else {
          // Fallback: use the quick-highlighted code
          outputHtml += wrappedQuick
        }
      } else {
        // Non-mermaid code: just use escaped version
        // If you want syntax highlighting, add shikiPlugin
        outputHtml += wrappedQuick
      }

      yield* emit({
        raw: ctx.next,
        html: outputHtml,
        pass: 'full',
      })

      currentBlock = null
      return
    }

    // Regular code line: Quick highlight
    if (currentBlock) {
      const lineContent = ctx.chunk
      currentBlock.lines.push(lineContent)

      const quickLine = currentBlock.isMermaid
        ? quickHighlightMermaid(lineContent)
        : escapeHtml(lineContent)
      currentBlock.quickHtml += quickLine

      const wrappedQuick = wrapCodeBlock(currentBlock.quickHtml, currentBlock.language, true)
      yield* emit({
        raw: ctx.next,
        html: outputHtml + wrappedQuick,
        pass: 'quick',
      })
    }
  }
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
