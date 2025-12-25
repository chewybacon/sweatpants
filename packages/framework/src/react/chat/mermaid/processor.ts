/**
 * mermaid/processor.ts
 * 
 * Mermaid-aware processor with progressive enhancement.
 * 
 * This processor follows the same pattern as the Shiki processor:
 * 1. Quick pass: Syntax-highlighted mermaid code (renders immediately)
 * 2. Full pass: Rendered SVG diagram (when code fence closes)
 * 
 * ## How it works
 * 
 * The processor works with the codeFence settler from shiki/settlers:
 * 
 * ```
 * settler yields:
 *   { content: "```mermaid\n", meta: { inCodeFence: true, lang: "mermaid", fenceStart: true } }
 *   { content: "graph TD\n", meta: { inCodeFence: true, lang: "mermaid" } }
 *   { content: "  A --> B\n", meta: { inCodeFence: true, lang: "mermaid" } }
 *   { content: "```\n", meta: { inCodeFence: true, lang: "mermaid", fenceEnd: true, codeContent: "..." } }
 * 
 * processor does:
 *   1. For each code line: emit quick-highlighted mermaid syntax
 *   2. When fenceEnd: render to SVG and emit
 * ```
 * 
 * For non-mermaid code fences, this processor delegates to the regular
 * Shiki processor for syntax highlighting.
 */
import { marked } from 'marked'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'
import type { CodeFenceMeta } from '../shiki/settlers'
import { renderMermaid } from './loader'
import { highlightCode } from '../shiki/loader'

// --- Quick Highlighting for Mermaid Syntax ---

/**
 * Mermaid-specific quick highlighting patterns.
 * These provide immediate visual feedback while typing.
 */
const MERMAID_PATTERNS: Array<{ pattern: RegExp; className: string }> = [
  // Diagram type keywords
  { pattern: /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart|block-beta)\b/g, className: 'keyword' },
  // Direction keywords
  { pattern: /\b(TD|TB|BT|RL|LR)\b/g, className: 'keyword' },
  // Arrows and connections
  { pattern: /(-->|--o|--x|<-->|---|\.\.\.>|===|==>|-.->|-\.-)/g, className: 'operator' },
  // Node shapes: [text], (text), {text}, ((text)), [[text]], etc.
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
  // Labels with |text|
  { pattern: /(\|.*?\|)/g, className: 'string' },
  // IDs (word characters before arrows or at start of line)
  { pattern: /^(\s*)([A-Za-z_][A-Za-z0-9_]*)/gm, className: 'variable' },
]

/**
 * Apply quick regex-based highlighting to mermaid code.
 */
function quickHighlightMermaid(code: string): string {
  // Escape HTML first
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  
  // Build combined regex for single-pass tokenization
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
  
  const result = escaped.replace(combinedRegex, (...args) => {
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
  
  return result
}

/**
 * Wrap code in a pre/code block for display.
 */
function wrapCodeBlock(html: string, language: string, isQuick: boolean): string {
  const langClass = language ? ` language-${language}` : ''
  const quickClass = isQuick ? ' quick-highlight' : ' shiki-highlight'
  return `<pre class="code-block${quickClass}"><code class="${langClass}">${html}</code></pre>`
}

// --- State for Building Code Blocks ---

interface CodeBlockState {
  lines: string[]
  language: string
  quickHtml: string
  isMermaid: boolean
}

// --- The Mermaid-Aware Processor ---

/**
 * Mermaid processor with progressive enhancement.
 * 
 * For mermaid code blocks:
 * - Quick pass: Mermaid syntax highlighting
 * - Full pass: Rendered SVG diagram
 * 
 * For other code blocks:
 * - Delegates to Shiki highlighting
 * 
 * For text outside code blocks:
 * - Parses as markdown
 */
export function mermaidProcessor(): Processor {
  let currentBlock: CodeBlockState | null = null
  let markdownBuffer = ''
  let outputHtml = ''

  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const meta = ctx.meta as CodeFenceMeta | undefined

    // --- Outside code fence: Accumulate for markdown ---
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

    // --- Inside code fence ---

    // Fence start: Initialize block state
    if (meta.fenceStart) {
      // Finalize any pending markdown into outputHtml
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
      // Don't emit the fence marker itself
      return
    }

    // Fence end: Render the full block
    if (meta.fenceEnd && currentBlock) {
      const fullCode = meta.codeContent || currentBlock.lines.join('')
      const language = currentBlock.language

      // Emit quick version first (in case rendering takes time)
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
          // Fallback: use the quick-highlighted code we already have
          outputHtml += wrappedQuick
        }
      } else {
        // Shiki highlight for other languages
        const shikiHtml = yield* highlightCode(fullCode, language)
        outputHtml += shikiHtml
      }
      
      yield* emit({
        raw: ctx.next,
        html: outputHtml,
        pass: 'full',
      })

      currentBlock = null
      return
    }

    // Regular code line: Quick highlight and accumulate
    if (currentBlock) {
      const lineContent = ctx.chunk
      currentBlock.lines.push(lineContent)

      // Quick highlight based on whether it's mermaid or not
      const quickLine = currentBlock.isMermaid 
        ? quickHighlightMermaid(lineContent)
        : quickHighlightGeneric(lineContent, currentBlock.language)
      currentBlock.quickHtml += quickLine

      // Emit accumulated quick-highlighted code so far
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
 * Generic quick highlighting for non-mermaid code.
 * This is a simplified version - for full highlighting, use the Shiki processor.
 */
function quickHighlightGeneric(code: string, _language: string): string {
  // Just escape HTML - let Shiki do the real highlighting
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Quick-only mermaid processor (no actual rendering, just highlighting).
 * 
 * Use this for testing or when you don't want async mermaid rendering.
 */
export function quickMermaidProcessor(): Processor {
  let currentBlock: CodeBlockState | null = null
  let markdownBuffer = ''
  let outputHtml = ''

  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    const meta = ctx.meta as CodeFenceMeta | undefined

    if (!meta?.inCodeFence) {
      markdownBuffer += ctx.chunk
      const parsedMarkdown = marked.parse(markdownBuffer, { async: false }) as string
      yield* emit({ raw: ctx.next, html: outputHtml + parsedMarkdown })
      return
    }

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

    if (meta.fenceEnd && currentBlock) {
      const wrappedQuick = wrapCodeBlock(currentBlock.quickHtml, currentBlock.language, true)
      outputHtml += wrappedQuick
      yield* emit({ raw: ctx.next, html: outputHtml })
      currentBlock = null
      return
    }

    if (currentBlock) {
      const quickLine = currentBlock.isMermaid 
        ? quickHighlightMermaid(ctx.chunk)
        : quickHighlightGeneric(ctx.chunk, currentBlock.language)
      currentBlock.quickHtml += quickLine
      const wrappedQuick = wrapCodeBlock(currentBlock.quickHtml, currentBlock.language, true)
      yield* emit({ raw: ctx.next, html: outputHtml + wrappedQuick })
    }
  }
}
