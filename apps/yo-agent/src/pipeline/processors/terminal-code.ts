/**
 * Terminal Code Processor
 *
 * Provides syntax highlighting for code blocks using Shiki's ANSI output.
 *
 * Progressive enhancement:
 * - Quick pass: Simple regex-based highlighting (instant)
 * - Full pass: Full Shiki TextMate highlighting (async)
 *
 * Uses @shikijs/cli's codeToANSI for VS Code-quality terminal highlighting.
 */
import type { Operation } from 'effection'
import { call } from 'effection'
import type { Frame, Processor } from '@sweatpants/framework/react/chat/pipeline'
import {
  updateBlockById,
  setBlockRendered,
  addTrace,
} from '@sweatpants/framework/react/chat/pipeline'
import { codeToANSI } from '@shikijs/cli'
import type { BundledLanguage, BundledTheme } from 'shiki'
import chalk from 'chalk'

// =============================================================================
// Configuration
// =============================================================================

/** Default theme for code highlighting */
const DEFAULT_THEME: BundledTheme = 'vitesse-dark'

/** Common language aliases */
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
}

/**
 * Normalize language identifier to Shiki's expected format.
 */
function normalizeLanguage(lang: string): BundledLanguage {
  const lower = lang.toLowerCase()
  return (LANGUAGE_ALIASES[lower] as BundledLanguage) ?? (lower as BundledLanguage)
}

// =============================================================================
// Quick Highlighting (Regex-based)
// =============================================================================

/**
 * Quick highlighting patterns for common languages.
 * These provide instant feedback while Shiki loads.
 */
const QUICK_PATTERNS: Record<string, Array<{ pattern: RegExp; style: (s: string) => string }>> = {
  javascript: [
    { pattern: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false)\b/g, style: chalk.magenta },
    { pattern: /(\/\/.*$)/gm, style: chalk.dim },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, style: chalk.dim },
    { pattern: /(`(?:[^`\\]|\\.)*`)/g, style: chalk.green },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, style: chalk.green },
    { pattern: /\b(\d+\.?\d*)\b/g, style: chalk.yellow },
  ],
  python: [
    { pattern: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|yield|lambda|async|await|pass|break|continue)\b/g, style: chalk.magenta },
    { pattern: /\b(self|cls)\b/g, style: chalk.red },
    { pattern: /(#.*)$/gm, style: chalk.dim },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, style: chalk.green },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, style: chalk.green },
    { pattern: /\b(\d+\.?\d*)\b/g, style: chalk.yellow },
  ],
  json: [
    { pattern: /("(?:[^"\\]|\\.)*")(?=\s*:)/g, style: chalk.cyan },
    { pattern: /("(?:[^"\\]|\\.)*")/g, style: chalk.green },
    { pattern: /\b(true|false|null)\b/g, style: chalk.magenta },
    { pattern: /\b(-?\d+\.?\d*)\b/g, style: chalk.yellow },
  ],
  bash: [
    { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|source|alias|cd|pwd|echo|printf|read|set|unset|declare|local)\b/g, style: chalk.magenta },
    { pattern: /(#.*)$/gm, style: chalk.dim },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, style: chalk.green },
    { pattern: /(\$\{?\w+\}?)/g, style: chalk.cyan },
  ],
  yaml: [
    { pattern: /^(\s*[\w-]+)(?=:)/gm, style: chalk.cyan },
    { pattern: /:\s*(.+)$/gm, style: chalk.green },
    { pattern: /(#.*)$/gm, style: chalk.dim },
    { pattern: /\b(true|false|null|yes|no)\b/gi, style: chalk.magenta },
  ],
}

// Add aliases
QUICK_PATTERNS['typescript'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['tsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['jsx'] = QUICK_PATTERNS['javascript']!
QUICK_PATTERNS['sh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['shell'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['zsh'] = QUICK_PATTERNS['bash']!
QUICK_PATTERNS['py'] = QUICK_PATTERNS['python']!
QUICK_PATTERNS['yml'] = QUICK_PATTERNS['yaml']!

/**
 * Apply quick regex-based highlighting to code.
 */
function quickHighlight(code: string, language: string): string {
  const patterns = QUICK_PATTERNS[language.toLowerCase()]

  if (!patterns || patterns.length === 0) {
    // No patterns for this language, return as-is
    return code
  }

  let result = code

  // Apply each pattern
  // Note: This is a simple approach that may have overlapping issues
  // For production, consider a proper tokenizer
  for (const { pattern, style } of patterns) {
    result = result.replace(pattern, (match) => style(match))
  }

  return result
}

/**
 * Format code for terminal display.
 * Note: Visual container (border) is handled by FrameRenderer.
 */
function formatCodeBlock(code: string, _language: string, _isQuick: boolean): string {
  // Just return the highlighted code - FrameRenderer handles the container
  // Trim any trailing whitespace/newlines
  return code.trimEnd()
}

// =============================================================================
// Shiki ANSI Highlighting
// =============================================================================

/** Cache for highlighted code to avoid re-highlighting */
const highlightCache = new Map<string, string>()

/**
 * Highlight code using Shiki's ANSI output.
 */
async function highlightWithShiki(
  code: string,
  language: string,
  theme: BundledTheme = DEFAULT_THEME
): Promise<string> {
  const cacheKey = `${language}:${theme}:${code}`
  
  if (highlightCache.has(cacheKey)) {
    return highlightCache.get(cacheKey)!
  }

  try {
    const normalizedLang = normalizeLanguage(language)
    const result = await codeToANSI(code, normalizedLang, theme)
    
    // Trim trailing newline that codeToANSI adds
    const trimmed = result.replace(/\n$/, '')
    
    // Cache the result
    highlightCache.set(cacheKey, trimmed)
    
    return trimmed
  } catch (error) {
    // If Shiki fails (unknown language, etc.), fall back to quick highlight
    console.error(`Shiki highlight failed for ${language}:`, error)
    return quickHighlight(code, language)
  }
}

// =============================================================================
// Terminal Code Processor
// =============================================================================

/**
 * Terminal code processor.
 *
 * Provides progressive syntax highlighting:
 * 1. Quick pass: Instant regex-based highlighting while streaming
 * 2. Full pass: Complete Shiki ANSI highlighting when code block completes
 */
export const terminalCode: Processor = {
  name: 'terminal-code',
  description: 'Syntax highlighting for terminal using Shiki ANSI',

  // Run after terminal-markdown
  dependencies: ['terminal-markdown'],

  // Shiki loads lazily, always ready to start
  isReady: () => true,

  process: function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      // Only process code blocks
      if (block.type !== 'code') {
        continue
      }

      const language = block.language || 'text'

      if (block.status === 'streaming') {
        // Streaming: apply quick highlighting
        if (block.renderPass === 'none' || block.renderPass === 'quick') {
          const highlighted = quickHighlight(block.raw, language)
          const rendered = formatCodeBlock(highlighted, language, true)

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'quick')
          )

          if (block.renderPass === 'none') {
            currentFrame = addTrace(currentFrame, 'terminal-code', 'update', {
              blockId: block.id,
              detail: `quick highlight: ${language}`,
            })
          }
          changed = true
        }
      } else if (block.status === 'complete') {
        // Complete: apply full Shiki highlighting if not already done
        if (block.renderPass !== 'full') {
          const startTime = Date.now()
          
          const highlighted: string = yield* call(() =>
            highlightWithShiki(block.raw, language)
          )
          
          const durationMs = Date.now() - startTime
          const rendered = formatCodeBlock(highlighted, language, false)

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'full')
          )
          currentFrame = addTrace(currentFrame, 'terminal-code', 'update', {
            blockId: block.id,
            detail: `full highlight: ${language}`,
            durationMs,
          })
          changed = true
        }
      }
    }

    return changed ? currentFrame : frame
  },
}

// =============================================================================
// Exports
// =============================================================================

export { DEFAULT_THEME, normalizeLanguage }
