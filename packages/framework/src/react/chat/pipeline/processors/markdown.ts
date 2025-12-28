/**
 * pipeline/processors/markdown.ts
 *
 * Markdown processor - converts text blocks to HTML.
 *
 * This processor:
 * - Parses text blocks through marked
 * - Escapes code blocks (leaves highlighting to other processors)
 * - Is idempotent (safe to run multiple times)
 */
import type { Operation } from 'effection'
import { marked } from 'marked'
import type { Frame, Processor } from '../types'
import {
  updateBlockById,
  setBlockHtml,
  addTrace,
} from '../frame'
import { registerBuiltinProcessor } from '../resolver'

// =============================================================================
// HTML Escaping
// =============================================================================

/**
 * Escape HTML special characters.
 */
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

/**
 * Wrap code in a pre/code block.
 */
const wrapCodeBlock = (code: string, language: string): string => {
  const langClass = language ? ` class="language-${language}"` : ''
  return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`
}

// =============================================================================
// Markdown Processor
// =============================================================================

/**
 * Markdown processor.
 *
 * Parses text blocks through marked (markdown → HTML) and provides
 * basic HTML escaping for code blocks. Other processors (shiki, mermaid)
 * can enhance code blocks later.
 *
 * @example
 * ```typescript
 * import { markdown } from '@tanstack/framework/react/chat/processors'
 *
 * useChat({
 *   processors: [markdown]
 * })
 * ```
 */
export const markdown: Processor = {
  name: 'markdown',
  description: 'Parse markdown to HTML',

  // No dependencies - markdown is typically first
  dependencies: [],

  // No async assets to preload - omit preload field
  isReady: () => true,

  process: function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      if (block.type === 'text') {
        // For text blocks, render if no HTML yet or still streaming
        const shouldRender =
          block.renderPass === 'none' ||
          (block.status === 'streaming' && block.raw.length > 0)

        if (shouldRender) {
          const html = marked.parse(block.raw, { async: false }) as string

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockHtml(b, html, 'quick')
          )

          if (block.renderPass === 'none') {
            currentFrame = addTrace(currentFrame, 'markdown', 'update', {
              blockId: block.id,
              detail: 'parsed markdown',
            })
          }
          changed = true
        }
      } else if (block.type === 'code') {
        // For code blocks, provide basic escaping
        if (block.renderPass === 'none') {
          const html = wrapCodeBlock(block.raw, block.language || '')

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockHtml(b, html, 'quick')
          )
          currentFrame = addTrace(currentFrame, 'markdown', 'update', {
            blockId: block.id,
            detail: `escaped code: ${block.language || 'plain'}`,
          })
          changed = true
        } else if (block.status === 'streaming') {
          // Code block is still streaming - update the escaped HTML
          const html = wrapCodeBlock(block.raw, block.language || '')

          currentFrame = updateBlockById(currentFrame, block.id, (b) => ({
            ...b,
            html,
            // Keep the same renderPass
          }))
          changed = true
        }
      }
    }

    return changed ? currentFrame : frame
  },
}

// Register as built-in for auto-dependency resolution
registerBuiltinProcessor('markdown', () => markdown)
