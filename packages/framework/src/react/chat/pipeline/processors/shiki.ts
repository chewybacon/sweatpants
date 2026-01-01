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
import { call } from 'effection'
import type { Frame, Processor } from '../types'
import {
  updateBlockById,
  setBlockRendered,
  addTrace,
} from '../frame'
import {
  highlightCode,
  preloadHighlighter,
  isHighlighterReady,
} from '../../shiki/loader'
import { registerBuiltinProcessor } from '../resolver'

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
QUICK_PATTERNS['typescript'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['tsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['jsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['sh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['shell'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['zsh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['py'] = QUICK_PATTERNS['python']!

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
 * Shiki syntax highlighting processor.
 *
 * Provides progressive syntax highlighting:
 * 1. Quick pass: Instant regex-based highlighting while streaming
 * 2. Full pass: Complete Shiki highlighting when code block completes
 *
 * @example
 * ```typescript
 * import { shiki } from '@tanstack/framework/react/chat/processors'
 *
 * useChat({
 *   processors: [shiki]  // markdown will be auto-added as dependency
 * })
 * ```
 */
export const shiki: Processor = {
  name: 'shiki',
  description: 'Syntax highlighting with Shiki',

  // Depends on markdown for basic code block structure
  dependencies: ['markdown'],

  *preload() {
    yield* call(() => preloadHighlighter())
  },

  isReady: isHighlighterReady,

  process: function* (frame: Frame): Operation<Frame> {
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
          const rendered = wrapCodeBlock(highlighted, block.language || '', true)

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'quick')
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
          const rendered = yield* highlightCode(block.raw, block.language || '')
          const durationMs = Date.now() - startTime

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'full')
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
  },
}

// Register as built-in for auto-dependency resolution
registerBuiltinProcessor('shiki', () => shiki)

// =============================================================================
// Preload Helper (for external use)
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
