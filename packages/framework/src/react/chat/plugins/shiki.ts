/**
 * plugins/shiki.ts
 *
 * Shiki syntax highlighting plugin with progressive enhancement.
 *
 * This plugin provides:
 * - Quick pass: Instant regex-based highlighting
 * - Full pass: Async Shiki highlighting when code fence closes
 *
 * Depends on: markdown (runs after markdown for HTML enhancement)
 */
import type { Operation } from 'effection'
import { call } from 'effection'
import { marked } from 'marked'
import type { ProcessorPlugin } from './types'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'
import type { CodeFenceMeta } from '../settlers/code-fence'
import {
  highlightCode,
  preloadHighlighter,
  isHighlighterReady,
} from '../shiki/loader'

// --- Quick Highlighting (Instant, Regex-based) ---

/**
 * Language-specific quick highlighting patterns.
 * These are fast regex patterns that give decent results instantly.
 */
const QUICK_PATTERNS: Record<string, Array<{ pattern: RegExp; className: string }>> = {
  python: [
    { pattern: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|yield|lambda|async|await|pass|break|continue|global|nonlocal)\b/g, className: 'keyword' },
    { pattern: /\b(self|cls)\b/g, className: 'variable' },
    { pattern: /(#.*)$/gm, className: 'comment' },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' },
  ],
  javascript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false)\b/g, className: 'keyword' },
    { pattern: /(\/\/.*$)/gm, className: 'comment' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /(`(?:[^`\\]|\\.)*`)/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' },
  ],
  json: [
    { pattern: /("(?:[^"\\]|\\.)*")(?=\s*:)/g, className: 'property' },
    { pattern: /("(?:[^"\\]|\\.)*")/g, className: 'string' },
    { pattern: /\b(true|false|null)\b/g, className: 'keyword' },
    { pattern: /\b(-?\d+\.?\d*)\b/g, className: 'number' },
  ],
  bash: [
    { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|source|alias|unalias|cd|pwd|echo|printf|read|set|unset|declare|local|readonly)\b/g, className: 'keyword' },
    { pattern: /(#.*)$/gm, className: 'comment' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /(\$\{?\w+\}?)/g, className: 'variable' },
  ],
  css: [
    { pattern: /([.#][\w-]+)/g, className: 'selector' },
    { pattern: /([\w-]+)(?=\s*:)/g, className: 'property' },
    { pattern: /(#[0-9a-fA-F]{3,8})/g, className: 'color' },
    { pattern: /\b(\d+\.?\d*(px|em|rem|%|vh|vw|s|ms)?)\b/g, className: 'number' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
  ],
  html: [
    { pattern: /(&lt;\/?[\w-]+)/g, className: 'tag' },
    { pattern: /([\w-]+)(?==)/g, className: 'attribute' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /(&lt;!--[\s\S]*?--&gt;)/g, className: 'comment' },
  ],
}

// Language aliases
QUICK_PATTERNS['typescript'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['tsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['jsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['sh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['shell'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['zsh'] = QUICK_PATTERNS['bash']!

/**
 * Apply quick regex-based highlighting to code.
 */
function quickHighlight(code: string, language: string): string {
  const patterns = QUICK_PATTERNS[language.toLowerCase()]
  if (!patterns || patterns.length === 0) {
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  const combinedParts: string[] = []
  const patternInfo: Array<{ className: string; groupIndex: number }> = []
  let groupCount = 0

  for (const { pattern, className } of patterns) {
    combinedParts.push(pattern.source)
    patternInfo.push({ className, groupIndex: groupCount + 1 })
    const groupsInPattern = (pattern.source.match(/\((?!\?)/g) || []).length
    groupCount += groupsInPattern
  }

  const combinedRegex = new RegExp(combinedParts.join('|'), 'gm')

  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

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
 * Wrap code in a pre/code block for display.
 */
function wrapCodeBlock(html: string, language: string, isQuick: boolean): string {
  const langClass = language ? ` language-${language}` : ''
  const quickClass = isQuick ? ' quick-highlight' : ' shiki-highlight'
  return `<pre class="code-block${quickClass}"><code class="${langClass}">${html}</code></pre>`
}

// --- Shiki Processor ---

interface CodeBlockState {
  lines: string[]
  language: string
  quickHtml: string
}

/**
 * Create the Shiki processor.
 */
function createShikiProcessor(): Processor {
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

      currentBlock = {
        lines: [],
        language: meta.language || 'text',
        quickHtml: '',
      }
      return
    }

    // Fence end: Full Shiki highlight
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

      // Full Shiki highlighting
      const shikiHtml = yield* highlightCode(fullCode, language)

      outputHtml += shikiHtml
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

      const quickLine = quickHighlight(lineContent, currentBlock.language)
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
 * Shiki syntax highlighting plugin.
 *
 * Provides progressive syntax highlighting:
 * 1. Quick pass: Instant regex-based highlighting while typing
 * 2. Full pass: Complete Shiki highlighting when code fence closes
 *
 * @example
 * ```typescript
 * import { shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [shikiPlugin]
 * })
 * ```
 */
export const shikiPlugin: ProcessorPlugin = {
  name: 'shiki',
  description: 'Progressive syntax highlighting with Shiki',
  settler: 'codeFence',

  *preload(): Operation<void> {
    yield* call(() => preloadHighlighter())
  },

  isReady: isHighlighterReady,

  processor: createShikiProcessor,
}
