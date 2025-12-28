/**
 * pipeline/processors/shiki.ts
 *
 * Shiki syntax highlighting processor.
 *
 * This processor:
 * - Quick pass: Instant regex-based highlighting for streaming
 * - Full pass: Complete Shiki highlighting when code block completes
 *
 * Works on code blocks, enhancing their HTML.
 */
import type { Operation } from 'effection'
import type { Frame, Block, Processor, ProcessorFactory } from '../types'
import {
  updateBlockById,
  setBlockHtml,
  addTrace,
  updateBlock,
} from '../frame'
import {
  highlightCode,
  preloadHighlighter,
  isHighlighterReady,
} from '../../shiki/loader'

// =============================================================================
// Quick Highlighting (Regex-based)
// =============================================================================

/**
 * Language-specific quick highlighting patterns.
 */
const QUICK_PATTERNS: Record<string, Array<{ pattern: RegExp; className: string }>> = {
  javascript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false)\b/g, className: 'keyword' },
    { pattern: /(\/\/.*$)/gm, className: 'comment' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /(`(?:[^`\\]|\\.)*`)/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' },
  ],
  python: [
    { pattern: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|yield|lambda|async|await|pass|break|continue|global|nonlocal)\b/g, className: 'keyword' },
    { pattern: /\b(self|cls)\b/g, className: 'variable' },
    { pattern: /(#.*)$/gm, className: 'comment' },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, className: 'string' },
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
}

// Language aliases
QUICK_PATTERNS['typescript'] = QUICK_PATTERNS['javascript']
QUICK_PATTERNS['tsx'] = QUICK_PATTERNS['javascript']
QUICK_PATTERNS['jsx'] = QUICK_PATTERNS['javascript']
QUICK_PATTERNS['sh'] = QUICK_PATTERNS['bash']
QUICK_PATTERNS['shell'] = QUICK_PATTERNS['bash']
QUICK_PATTERNS['zsh'] = QUICK_PATTERNS['bash']
QUICK_PATTERNS['py'] = QUICK_PATTERNS['python']

/**
 * Apply quick regex-based highlighting to code.
 */
function quickHighlight(code: string, language: string): string {
  const patterns = QUICK_PATTERNS[language.toLowerCase()]

  // Start with HTML escaping
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  if (!patterns || patterns.length === 0) {
    return escaped
  }

  // Build combined regex
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
 * Wrap highlighted code in a pre/code block.
 */
function wrapCodeBlock(html: string, language: string, isQuick: boolean): string {
  const langClass = language ? ` language-${language}` : ''
  const passClass = isQuick ? ' quick-highlight' : ' shiki-highlight'
  return `<pre class="code-block${passClass}"><code class="${langClass}">${html}</code></pre>`
}

// =============================================================================
// Shiki Processor
// =============================================================================

/**
 * Create a Shiki syntax highlighting processor.
 *
 * This processor:
 * 1. Quick pass: Applies regex-based highlighting to streaming code blocks
 * 2. Full pass: Applies Shiki highlighting when code block completes
 *
 * The processor is idempotent - it checks renderPass before processing.
 */
export const createShikiProcessor: ProcessorFactory = () => {
  const processor: Processor = function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      // Only process code blocks
      if (block.type !== 'code') {
        continue
      }

      // Skip mermaid blocks (handled by mermaid processor)
      if (block.language?.toLowerCase() === 'mermaid') {
        continue
      }

      if (block.status === 'streaming') {
        // Streaming: apply quick highlighting
        if (block.renderPass === 'none' || block.renderPass === 'quick') {
          const highlighted = quickHighlight(block.raw, block.language || '')
          const html = wrapCodeBlock(highlighted, block.language || '', true)

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockHtml(b, html, 'quick')
          )

          if (block.renderPass === 'none') {
            currentFrame = addTrace(currentFrame, 'shiki', 'update', {
              blockId: block.id,
              detail: `quick highlight: ${block.language || 'plain'}`,
            })
          }
          changed = true
        }
      } else if (block.status === 'complete') {
        // Complete: apply full Shiki highlighting if not already done
        if (block.renderPass !== 'full') {
          const startTime = Date.now()
          const html = yield* highlightCode(block.raw, block.language || '')
          const durationMs = Date.now() - startTime

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockHtml(b, html, 'full')
          )
          currentFrame = addTrace(currentFrame, 'shiki', 'update', {
            blockId: block.id,
            detail: `full highlight: ${block.language || 'plain'}`,
            durationMs,
          })
          changed = true
        }
      }
    }

    return changed ? currentFrame : frame
  }

  return processor
}

// =============================================================================
// Preload Helper
// =============================================================================

/**
 * Preload Shiki highlighter.
 * Call this early to avoid delay when first code block completes.
 */
export const preloadShiki = preloadHighlighter

/**
 * Check if Shiki is ready.
 */
export const isShikiReady = isHighlighterReady

// =============================================================================
// Default Export
// =============================================================================

export const shikiProcessor = createShikiProcessor
