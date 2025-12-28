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
import type { Frame, Block, Processor, ProcessorFactory } from '../types'
import {
  updateFrame,
  updateBlockById,
  setBlockHtml,
  addTrace,
  renderFrameToRaw,
} from '../frame'

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
 * Create a markdown processor.
 *
 * This processor:
 * 1. Parses text blocks through marked (markdown → HTML)
 * 2. Escapes code blocks (basic HTML escaping)
 * 3. Only processes blocks that haven't been rendered yet
 *
 * Other processors (shiki, mermaid) can enhance code blocks later.
 */
export const createMarkdownProcessor: ProcessorFactory = () => {
  const processor: Processor = function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      // Skip blocks that already have HTML
      if (block.renderPass !== 'none') {
        continue
      }

      if (block.type === 'text') {
        // Parse markdown
        const html = marked.parse(block.raw, { async: false }) as string

        currentFrame = updateBlockById(currentFrame, block.id, (b) =>
          setBlockHtml(b, html, 'quick')
        )
        currentFrame = addTrace(currentFrame, 'markdown', 'update', {
          blockId: block.id,
          detail: 'parsed markdown',
        })
        changed = true
      } else if (block.type === 'code') {
        // Basic HTML escaping for code blocks
        // Other processors will enhance with syntax highlighting
        const html = wrapCodeBlock(block.raw, block.language || '')

        currentFrame = updateBlockById(currentFrame, block.id, (b) =>
          setBlockHtml(b, html, 'quick')
        )
        currentFrame = addTrace(currentFrame, 'markdown', 'update', {
          blockId: block.id,
          detail: `escaped code: ${block.language || 'no language'}`,
        })
        changed = true
      }
    }

    // If nothing changed, return original frame (referential equality)
    return changed ? currentFrame : frame
  }

  return processor
}

// =============================================================================
// Streaming Markdown Processor
// =============================================================================

/**
 * Create a streaming-aware markdown processor.
 *
 * This is similar to the basic markdown processor, but also handles
 * streaming blocks - rendering partial content with a visual indicator.
 */
export const createStreamingMarkdownProcessor: ProcessorFactory = () => {
  const processor: Processor = function* (frame: Frame): Operation<Frame> {
    let currentFrame = frame
    let changed = false

    for (const block of frame.blocks) {
      if (block.type === 'text') {
        // For text blocks, always re-render if content might have changed
        // (streaming blocks grow over time)
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
        // For code blocks, only do basic escaping if not already processed
        if (block.renderPass === 'none') {
          const html = wrapCodeBlock(block.raw, block.language || '')

          currentFrame = updateBlockById(currentFrame, block.id, (b) =>
            setBlockHtml(b, html, 'quick')
          )
          currentFrame = addTrace(currentFrame, 'markdown', 'update', {
            blockId: block.id,
            detail: `escaped code: ${block.language || 'no language'}`,
          })
          changed = true
        } else if (block.status === 'streaming') {
          // Code block is still streaming - update the escaped HTML
          const html = wrapCodeBlock(block.raw, block.language || '')

          currentFrame = updateBlockById(currentFrame, block.id, (b) => ({
            ...b,
            html,
            // Keep the same renderPass - don't upgrade
          }))
          changed = true
        }
      }
    }

    return changed ? currentFrame : frame
  }

  return processor
}

// =============================================================================
// Default Export
// =============================================================================

export const markdownProcessor = createStreamingMarkdownProcessor
