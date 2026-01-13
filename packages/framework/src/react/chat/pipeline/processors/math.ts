/**
 * pipeline/processors/math.ts
 *
 * Math rendering processor using KaTeX.
 *
 * This processor:
 * - Detects inline math ($...$) and block math ($$...$$)
 * - Adds annotations for each math expression
 * - Renders math using KaTeX
 *
 * Works on text blocks, finding and rendering math expressions.
 *
 * ## Math Syntax
 *
 * - Inline: `$x^2 + y^2 = z^2$` renders inline with surrounding text
 * - Block: `$$\int_0^1 f(x) dx$$` renders as a centered block
 *
 * ## Annotations
 *
 * Each math expression creates an annotation:
 * ```typescript
 * {
 *   type: 'math',
 *   subtype: 'inline' | 'block',
 *   rawStart: number,
 *   rawEnd: number,
 *   data: { latex: string }
 * }
 * ```
 */
import type { Operation } from 'effection'
import type { Frame, Processor, Annotation, Block } from '../types.ts'
import { addTrace } from '../frame.ts'
import {
  renderMath,
  renderMathSync,
  preloadKatex as preloadKatexLoader,
  isKatexReady as isKatexReadyLoader,
} from '../../math/loader.ts'
import { registerBuiltinProcessor } from '../resolver.ts'

// =============================================================================
// Math Detection
// =============================================================================

/**
 * A detected math expression.
 */
interface MathMatch {
  /** Full match including delimiters */
  full: string
  /** LaTeX content without delimiters */
  latex: string
  /** Start index in source string */
  start: number
  /** End index in source string */
  end: number
  /** Display mode (block) or inline */
  displayMode: boolean
}

/**
 * Check if a range overlaps with any existing match.
 */
function overlapsExisting(
  start: number,
  end: number,
  matches: MathMatch[]
): boolean {
  return matches.some(
    (m) =>
      (start >= m.start && start < m.end) ||
      (end > m.start && end <= m.end) ||
      (start <= m.start && end >= m.end)
  )
}

/**
 * Find all math expressions in a string.
 *
 * Matches (in order of priority):
 * - Block math: $$...$$ or \[...\] (can span multiple lines)
 * - Inline math: $...$ or \(...\) (single line)
 *
 * Block math is matched first to avoid conflicts with inline patterns.
 */
function findMathExpressions(text: string): MathMatch[] {
  const matches: MathMatch[] = []

  // Block math: $$...$$
  const blockDollarRegex = /\$\$([\s\S]+?)\$\$/g
  let match: RegExpExecArray | null

  while ((match = blockDollarRegex.exec(text)) !== null) {
    if (!overlapsExisting(match.index, match.index + match[0].length, matches)) {
      matches.push({
        full: match[0],
        latex: match[1]!.trim(),
        start: match.index,
        end: match.index + match[0].length,
        displayMode: true,
      })
    }
  }

  // Block math: \[...\] (LaTeX display math, common from ChatGPT/OpenAI)
  const blockBracketRegex = /\\\[([\s\S]+?)\\\]/g

  while ((match = blockBracketRegex.exec(text)) !== null) {
    if (!overlapsExisting(match.index, match.index + match[0].length, matches)) {
      matches.push({
        full: match[0],
        latex: match[1]!.trim(),
        start: match.index,
        end: match.index + match[0].length,
        displayMode: true,
      })
    }
  }

  // Block math: [ ... ] (plain brackets, but only if content looks like LaTeX)
  // This is a fallback for LLMs that output math without proper escaping
  // We require the content to look like math to avoid matching markdown links
  const plainBracketRegex = /\[\s*([\s\S]+?)\s*\]/g
  
  // Pattern to detect LaTeX commands
  const latexCommandPattern = /\\(?:frac|sqrt|int|sum|prod|lim|sin|cos|tan|log|ln|exp|alpha|beta|gamma|delta|theta|pi|sigma|omega|infty|partial|nabla|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|subset|supset|cap|cup|in|notin|forall|exists|rightarrow|leftarrow|Rightarrow|Leftarrow|begin|end|text|mathrm|mathbf|mathit|over|under|hat|bar|vec|dot|ddot|tilde)/
  
  // Pattern to detect math notation (superscripts, subscripts, equations)
  // Matches things like: x^2, a_1, x = y, etc.
  const mathNotationPattern = /[a-zA-Z]\^[\d{]|[a-zA-Z]_[\d{]|[a-zA-Z]\s*=\s*[a-zA-Z0-9]/

  while ((match = plainBracketRegex.exec(text)) !== null) {
    const content = match[1]!
    // Only treat as math if it contains LaTeX commands or math notation
    if (!latexCommandPattern.test(content) && !mathNotationPattern.test(content)) {
      continue
    }
    // Additional check: shouldn't look like a markdown link (no URLs)
    if (/https?:\/\/|www\./.test(content)) {
      continue
    }
    if (!overlapsExisting(match.index, match.index + match[0].length, matches)) {
      matches.push({
        full: match[0],
        latex: content.trim(),
        start: match.index,
        end: match.index + match[0].length,
        displayMode: true,
      })
    }
  }

  // Inline math: $...$ (must not be escaped, no newlines)
  const inlineDollarRegex = /(?<!\\)\$([^\$\n]+?)\$/g

  while ((match = inlineDollarRegex.exec(text)) !== null) {
    if (overlapsExisting(match.index, match.index + match[0].length, matches)) {
      continue
    }
    const latex = match[1]!
    if (!latex.trim()) continue

    matches.push({
      full: match[0],
      latex: latex,
      start: match.index,
      end: match.index + match[0].length,
      displayMode: false,
    })
  }

  // Inline math: \(...\) (LaTeX inline math, common from ChatGPT/OpenAI)
  const inlineParenRegex = /\\\(([\s\S]+?)\\\)/g

  while ((match = inlineParenRegex.exec(text)) !== null) {
    if (overlapsExisting(match.index, match.index + match[0].length, matches)) {
      continue
    }
    const latex = match[1]!
    if (!latex.trim()) continue

    matches.push({
      full: match[0],
      latex: latex,
      start: match.index,
      end: match.index + match[0].length,
      displayMode: false,
    })
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start)

  return matches
}

/**
 * Convert a MathMatch to an Annotation.
 */
function matchToAnnotation(match: MathMatch): Annotation {
  return {
    type: 'math',
    subtype: match.displayMode ? 'block' : 'inline',
    rawStart: match.start,
    rawEnd: match.end,
    data: { latex: match.latex },
  }
}

// =============================================================================
// HTML Rendering
// =============================================================================

/**
 * Escape special HTML characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Wrap rendered math in appropriate container.
 */
function wrapMath(html: string, displayMode: boolean): string {
  if (displayMode) {
    return `<div class="math-block">${html}</div>`
  }
  return `<span class="math-inline">${html}</span>`
}

/**
 * Create a fallback display for math that couldn't be rendered.
 */
function fallbackMath(latex: string, displayMode: boolean, error?: string): string {
  const escaped = escapeHtml(latex)
  const errorAttr = error ? ` data-error="${escapeHtml(error)}"` : ''

  if (displayMode) {
    return `<div class="math-block math-error"${errorAttr}><code>$$${escaped}$$</code></div>`
  }
  return `<span class="math-inline math-error"${errorAttr}><code>$${escaped}$</code></span>`
}

/**
 * Render all math in HTML content.
 *
 * Strategy: Find math delimiters in the HTML and replace them.
 * This works because markdown typically preserves $...$ and $$...$$ as-is.
 */
function* renderMathInHtml(
  html: string,
  matches: MathMatch[],
  useSync: boolean
): Operation<string> {
  if (matches.length === 0) return html

  let result = html

  // Process in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!

    // Find this math expression in the HTML
    // We search for the original delimited form
    const searchFor = match.displayMode
      ? `$$${match.latex}$$`
      : `$${match.latex}$`

    const idx = result.indexOf(searchFor)
    if (idx === -1) {
      // Try with the full original match (might have whitespace differences)
      const altIdx = result.indexOf(match.full)
      if (altIdx === -1) continue
    }

    // Render the math
    let rendered: string

    if (useSync) {
      const syncResult = renderMathSync(match.latex, match.displayMode)
      if (syncResult) {
        rendered = wrapMath(syncResult, match.displayMode)
      } else {
        rendered = fallbackMath(match.latex, match.displayMode)
      }
    } else {
      const renderResult = yield* renderMath(match.latex, match.displayMode)
      if (renderResult.success) {
        rendered = wrapMath(renderResult.html, match.displayMode)
      } else {
        rendered = fallbackMath(match.latex, match.displayMode, renderResult.error)
      }
    }

    // Replace in result
    result = result.replace(match.full, rendered)
  }

  return result
}

// =============================================================================
// Math Processor
// =============================================================================

/**
 * Math rendering processor.
 *
 * Detects and renders LaTeX math expressions in text blocks:
 * - Inline math: $x^2$
 * - Block math: $$\int f(x) dx$$
 *
 * Creates annotations for each math expression, allowing other systems
 * (TTS, accessibility) to handle math specially.
 *
 * @example
 * ```typescript
 * import { math } from '@sweatpants/framework/react/chat/pipeline'
 *
 * useChat({
 *   pipeline: { processors: [markdown, math] }
 * })
 * ```
 */
export const math: Processor = {
  name: 'math',
  description: 'Render LaTeX math with KaTeX',

  // Run after markdown so we work on markdown-processed HTML
  dependencies: ['markdown'],

  *preload() {
    yield* preloadKatexLoader()
  },

  isReady: isKatexReadyLoader,

  process: function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      // Only process text blocks
      if (block.type !== 'text') {
        continue
      }

      // Find math expressions in raw content
      const matches = findMathExpressions(block.raw)

      if (matches.length === 0) {
        continue
      }

      // Get the current block state from currentFrame (might have been updated)
      const currentBlock = currentFrame.blocks.find((b) => b.id === block.id) ?? block

      // Check if we've already processed this block (has math annotations)
      const existingMathAnnotations = (currentBlock.annotations ?? []).filter(
        (a) => a.type === 'math'
      )
      
      // Skip if we already have the right number of annotations
      // (idempotency - don't re-add if already processed)
      if (existingMathAnnotations.length >= matches.length) {
        continue
      }

      // Create annotations (replacing any existing math annotations)
      const annotations = matches.map(matchToAnnotation)
      const nonMathAnnotations = (currentBlock.annotations ?? []).filter(
        (a) => a.type !== 'math'
      )

      // Update block with annotations (replace math annotations, keep others)
      let updatedBlock: Block = {
        ...currentBlock,
        annotations: [...nonMathAnnotations, ...annotations],
      }

      // Render math in rendered output
      if (block.rendered) {
        const katexReady = isKatexReadyLoader()
        const newRendered = yield* renderMathInHtml(block.rendered, matches, katexReady)

        if (newRendered !== block.rendered) {
          updatedBlock = {
            ...updatedBlock,
            rendered: newRendered,
            // Keep same renderPass - we're enhancing, not changing quality level
          }
        }
      }

      // Apply updates
      currentFrame = {
        ...currentFrame,
        blocks: currentFrame.blocks.map((b) =>
          b.id === block.id ? updatedBlock : b
        ),
      }

      currentFrame = addTrace(currentFrame, 'math', 'update', {
        blockId: block.id,
        detail: `rendered ${matches.length} math expression(s)`,
      })

      changed = true
    }

    return changed ? currentFrame : frame
  },
}

// Register as built-in for auto-dependency resolution
registerBuiltinProcessor('math', () => math)

// =============================================================================
// Exports
// =============================================================================

/**
 * Preload KaTeX for faster first render.
 */
export const preloadMath = preloadKatexLoader

/**
 * Check if KaTeX is ready.
 */
export const isMathReady = isKatexReadyLoader
