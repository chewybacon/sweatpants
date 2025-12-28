/**
 * shiki/processor.ts
 * 
 * Progressive syntax highlighting processor using Shiki.
 * 
 * This processor implements the quick→full pattern:
 * 1. Quick pass: Instant regex-based highlighting (renders immediately)
 * 2. Full pass: Async Shiki highlighting (replaces when ready)
 * 
 * ## Architecture
 * 
 * The processor works with the codeFence settler:
 * 
 * ```
 * settler yields:
 *   { content: "def foo():\n", meta: { inCodeFence: true, lang: "python" } }
 *   { content: "    return 42\n", meta: { inCodeFence: true, lang: "python" } }
 *   { content: "```\n", meta: { inCodeFence: true, lang: "python", fenceEnd: true, codeContent: "..." } }
 * 
 * processor does:
 *   1. For each code line: emit quick-highlighted HTML
 *   2. When fenceEnd: yield* highlightCode() → emit full Shiki HTML
 * ```
 * 
 * The dual buffer accumulates these emissions into settledHtml.
 */
import { marked } from 'marked'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'
import type { CodeFenceMeta } from '../settlers/code-fence'
import { highlightCode } from './loader'

// --- Quick Highlighting (Instant, Regex-based) ---

/**
 * Language-specific quick highlighting patterns.
 * These are fast regex patterns that give decent results instantly.
 */
const QUICK_PATTERNS: Record<string, Array<{ pattern: RegExp; className: string }>> = {
  // Python
  python: [
    { pattern: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|yield|lambda|async|await|pass|break|continue|global|nonlocal)\b/g, className: 'keyword' },
    { pattern: /\b(self|cls)\b/g, className: 'variable' },
    { pattern: /(#.*)$/gm, className: 'comment' },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' },
  ],
  // JavaScript/TypeScript
  javascript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false)\b/g, className: 'keyword' },
    { pattern: /(\/\/.*$)/gm, className: 'comment' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /(`(?:[^`\\]|\\.)*`)/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' },
  ],
  typescript: [], // Will use javascript patterns
  // JSON
  json: [
    { pattern: /("(?:[^"\\]|\\.)*")(?=\s*:)/g, className: 'property' },
    { pattern: /("(?:[^"\\]|\\.)*")/g, className: 'string' },
    { pattern: /\b(true|false|null)\b/g, className: 'keyword' },
    { pattern: /\b(-?\d+\.?\d*)\b/g, className: 'number' },
  ],
  // Bash/Shell
  bash: [
    { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|source|alias|unalias|cd|pwd|echo|printf|read|set|unset|declare|local|readonly)\b/g, className: 'keyword' },
    { pattern: /(#.*)$/gm, className: 'comment' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /(\$\{?\w+\}?)/g, className: 'variable' },
  ],
  // CSS
  css: [
    { pattern: /([.#][\w-]+)/g, className: 'selector' },
    { pattern: /([\w-]+)(?=\s*:)/g, className: 'property' },
    { pattern: /(#[0-9a-fA-F]{3,8})/g, className: 'color' },
    { pattern: /\b(\d+\.?\d*(px|em|rem|%|vh|vw|s|ms)?)\b/g, className: 'number' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
  ],
  // HTML
  html: [
    { pattern: /(&lt;\/?[\w-]+)/g, className: 'tag' },
    { pattern: /([\w-]+)(?==)/g, className: 'attribute' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /(&lt;!--[\s\S]*?--&gt;)/g, className: 'comment' },
  ],
}

// TypeScript uses JavaScript patterns
QUICK_PATTERNS['typescript'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['tsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['jsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['sh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['shell'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['zsh'] = QUICK_PATTERNS['bash']!

/**
 * Apply quick regex-based highlighting to code.
 * Returns HTML with span classes for styling.
 * 
 * Uses a single-pass tokenization approach to avoid patterns
 * matching content that was already highlighted.
 */
function quickHighlight(code: string, language: string): string {
  // Get patterns for this language
  const patterns = QUICK_PATTERNS[language.toLowerCase()]
  if (!patterns || patterns.length === 0) {
    // No patterns for this language, return escaped code
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  // Build a combined regex that matches any of our patterns
  // This ensures we process the string left-to-right, never matching inside already-matched content
  const combinedParts: string[] = []
  const patternInfo: Array<{ className: string; groupIndex: number }> = []
  let groupCount = 0
  
  for (const { pattern, className } of patterns) {
    // Wrap the entire pattern in a non-capturing group, then add our own capturing group
    // This way we have exactly one capture group per pattern
    // Convert: \b(keyword)\b -> (?:\b(keyword)\b)
    // We want to capture the inner group, so we need to track the index
    
    // Actually, simpler approach: just use the pattern as-is and count its groups
    // Each pattern has exactly one capture group (the thing to highlight)
    combinedParts.push(pattern.source)
    patternInfo.push({ className, groupIndex: groupCount + 1 }) // +1 because groups are 1-indexed in args
    
    // Count capture groups in this pattern (simple heuristic: count unescaped '(')
    const groupsInPattern = (pattern.source.match(/\((?!\?)/g) || []).length
    groupCount += groupsInPattern
  }
  
  // Create combined regex with all patterns as alternatives
  const combinedRegex = new RegExp(combinedParts.join('|'), 'gm')
  
  // Escape HTML first
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  
  // Apply the combined regex
  const result = escaped.replace(combinedRegex, (...args) => {
    // args: [fullMatch, ...captureGroups, offset, inputString]
    const fullMatch = args[0]
    const captureGroups = args.slice(1, -2) // Remove offset and input string
    
    // Find which pattern matched by checking its capture group
    for (const { className, groupIndex } of patternInfo) {
      const captured = captureGroups[groupIndex - 1] // -1 because array is 0-indexed
      if (captured !== undefined) {
        return `<span class="ql-${className}">${captured}</span>`
      }
    }
    
    // Shouldn't happen, but return the match unchanged
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

// --- The Shiki Processor ---

/**
 * State tracked across the stream for building code blocks.
 * This allows us to accumulate code and then Shiki-highlight the full block.
 */
interface CodeBlockState {
  /** Lines accumulated so far (for quick highlighting) */
  lines: string[]
  /** The language of this block */
  language: string
  /** Quick-highlighted HTML accumulated so far */
  quickHtml: string
}

/**
 * Shiki processor with progressive enhancement.
 * 
 * This processor:
 * 1. Outside code fences: Passes through to markdown
 * 2. Inside code fences: Quick-highlights line by line
 * 3. On fence close: Shiki highlights the complete block
 * 
 * The key insight is that we emit twice for code blocks:
 * - First emit: Quick-highlighted code (instant)
 * - Second emit: Shiki-highlighted code (when fenceEnd received)
 * 
 * ## Accumulation Strategy
 * 
 * We maintain a running `outputHtml` buffer that accumulates ALL content:
 * - Markdown text is parsed and appended
 * - Code blocks are highlighted and appended
 * 
 * Each emit contains the FULL accumulated HTML so far.
 */
export function shikiProcessor(): Processor {
  // Track current code block state
  let currentBlock: CodeBlockState | null = null
  // Running markdown buffer for text outside code blocks
  let markdownBuffer = ''
  // Accumulated final HTML (includes both markdown and code blocks)
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
      
      currentBlock = {
        lines: [],
        language: meta.language || 'text',
        quickHtml: '',
      }
      // Don't emit the fence marker itself
      return
    }

    // Fence end: Full Shiki highlight
    if (meta.fenceEnd && currentBlock) {
      const fullCode = meta.codeContent || currentBlock.lines.join('')
      const language = currentBlock.language

      // Emit quick version first (in case Shiki takes time)
      const quickHtml = currentBlock.quickHtml
      const wrappedQuick = wrapCodeBlock(quickHtml, language, true)
      yield* emit({
        raw: ctx.next,
        html: outputHtml + wrappedQuick,
        pass: 'quick',
      })

      // Now do full Shiki highlighting
      const shikiHtml = yield* highlightCode(fullCode, language)
      
      // Append the Shiki HTML to output and emit
      outputHtml += shikiHtml
      yield* emit({
        raw: ctx.next,
        html: outputHtml,
        pass: 'full',
      })

      // Reset only the code block state, keep outputHtml for subsequent content
      currentBlock = null
      return
    }

    // Regular code line: Quick highlight and accumulate
    if (currentBlock) {
      const lineContent = ctx.chunk
      currentBlock.lines.push(lineContent)

      // Quick highlight this line
      const quickLine = quickHighlight(lineContent, currentBlock.language)
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
 * Simple quick-highlight processor (no Shiki, just regex).
 * 
 * Use this for testing or when you don't want the async Shiki overhead.
 */
export function quickHighlightProcessor(): Processor {
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
      // Finalize any pending markdown into outputHtml
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

    if (meta.fenceEnd && currentBlock) {
      const wrappedQuick = wrapCodeBlock(currentBlock.quickHtml, currentBlock.language, true)
      outputHtml += wrappedQuick
      yield* emit({ raw: ctx.next, html: outputHtml })
      currentBlock = null
      return
    }

    if (currentBlock) {
      const quickLine = quickHighlight(ctx.chunk, currentBlock.language)
      currentBlock.quickHtml += quickLine
      const wrappedQuick = wrapCodeBlock(currentBlock.quickHtml, currentBlock.language, true)
      yield* emit({ raw: ctx.next, html: outputHtml + wrappedQuick })
    }
  }
}
