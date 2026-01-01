/**
 * Terminal Markdown Processor
 *
 * Processes text blocks and converts inline markdown to ANSI-styled text.
 * 
 * Supports:
 * - **bold** → chalk.bold
 * - *italic* → chalk.italic
 * - `code` → chalk.yellow
 * - [text](url) → chalk.blue.underline (with hyperlink if supported)
 * - ~~strikethrough~~ → chalk.strikethrough
 *
 * Block-level elements (headers, lists, blockquotes) are handled at the
 * frame/block level, not here.
 */
import type { Operation } from 'effection'
import type { Frame, Processor } from '@tanstack/framework/react/chat/pipeline'
import {
  updateBlockById,
  setBlockRendered,
  addTrace,
} from '@tanstack/framework/react/chat/pipeline'
import chalk from 'chalk'

// =============================================================================
// Inline Markdown Parsing
// =============================================================================

/**
 * Token types for inline markdown
 */
type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string }
  | { type: 'code'; content: string }
  | { type: 'strikethrough'; content: string }
  | { type: 'link'; text: string; url: string }

/**
 * Parse inline markdown into tokens.
 * 
 * This is a simple parser that handles the most common inline elements.
 * It processes in order of specificity to avoid conflicts.
 */
function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let remaining = text

  // Combined regex for all inline elements
  // Order matters: more specific patterns first
  const patterns = [
    // Bold: **text** or __text__
    { regex: /\*\*(.+?)\*\*|__(.+?)__/, type: 'bold' as const },
    // Italic: *text* or _text_ (but not inside words for _)
    { regex: /\*(.+?)\*|(?<!\w)_(.+?)_(?!\w)/, type: 'italic' as const },
    // Strikethrough: ~~text~~
    { regex: /~~(.+?)~~/, type: 'strikethrough' as const },
    // Code: `text`
    { regex: /`([^`]+)`/, type: 'code' as const },
    // Link: [text](url)
    { regex: /\[([^\]]+)\]\(([^)]+)\)/, type: 'link' as const },
  ]

  while (remaining.length > 0) {
    let earliestMatch: {
      index: number
      length: number
      token: InlineToken
    } | null = null

    // Find the earliest matching pattern
    for (const { regex, type } of patterns) {
      const match = remaining.match(regex)
      if (match && match.index !== undefined) {
        const candidateIndex = match.index
        if (earliestMatch === null || candidateIndex < earliestMatch.index) {
          let token: InlineToken

          if (type === 'link') {
            token = {
              type: 'link',
              text: match[1]!,
              url: match[2]!,
            }
          } else {
            // For bold/italic, content might be in group 1 or 2 depending on delimiter
            const content = match[1] || match[2] || ''
            token = { type, content }
          }

          earliestMatch = {
            index: candidateIndex,
            length: match[0].length,
            token,
          }
        }
      }
    }

    if (earliestMatch === null) {
      // No more matches, add remaining as text
      if (remaining.length > 0) {
        tokens.push({ type: 'text', content: remaining })
      }
      break
    }

    // Add text before the match
    if (earliestMatch.index > 0) {
      tokens.push({
        type: 'text',
        content: remaining.slice(0, earliestMatch.index),
      })
    }

    // Add the matched token
    tokens.push(earliestMatch.token)

    // Continue with remaining text
    remaining = remaining.slice(earliestMatch.index + earliestMatch.length)
  }

  return tokens
}

/**
 * Render tokens to ANSI-styled string.
 */
function renderTokensToAnsi(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.content
        case 'bold':
          return chalk.bold(token.content)
        case 'italic':
          return chalk.italic(token.content)
        case 'code':
          return chalk.yellow(token.content)
        case 'strikethrough':
          return chalk.strikethrough(token.content)
        case 'link':
          // Use hyperlink escape sequence if terminal supports it
          // Fallback: show text with URL in parentheses
          const linkText = chalk.blue.underline(token.text)
          // For now, just show the styled text
          // TODO: Add proper hyperlink support detection
          return linkText
        default:
          return ''
      }
    })
    .join('')
}

/**
 * Process a line of text, converting inline markdown to ANSI.
 */
function processLine(line: string): string {
  const tokens = parseInlineMarkdown(line)
  return renderTokensToAnsi(tokens)
}

/**
 * Process a full text block, handling each line.
 */
function processTextBlock(raw: string): string {
  return raw
    .split('\n')
    .map((line) => processLine(line))
    .join('\n')
}

// =============================================================================
// Terminal Markdown Processor
// =============================================================================

/**
 * Terminal markdown processor.
 *
 * Converts text blocks from raw markdown to ANSI-styled terminal output.
 * Only handles inline elements - block structure is already in the Frame.
 */
export const terminalMarkdown: Processor = {
  name: 'terminal-markdown',
  description: 'Convert inline markdown to ANSI terminal styles',

  // No dependencies - we work directly on raw content
  dependencies: [],

  isReady: () => true,

  process: function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      if (block.type === 'text') {
        // Process text blocks - convert markdown to ANSI
        const shouldRender =
          block.renderPass === 'none' ||
          (block.status === 'streaming' && block.raw.length > 0)

        if (shouldRender) {
          const rendered = processTextBlock(block.raw)

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'quick')
          )

          if (block.renderPass === 'none') {
            currentFrame = addTrace(currentFrame, 'terminal-markdown', 'update', {
              blockId: block.id,
              detail: 'converted to ANSI',
            })
          }
          changed = true
        }
      } else if (block.type === 'code') {
        // For code blocks, just pass through raw content with basic styling
        // The terminal-code processor will do syntax highlighting
        if (block.renderPass === 'none') {
          // Simple code block styling - dim border
          const rendered = chalk.dim('```' + (block.language || '')) + '\n' +
            block.raw +
            '\n' + chalk.dim('```')

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockRendered(b, rendered, 'none')
          )
          changed = true
        }
      }
    }

    return changed ? currentFrame : frame
  },
}
