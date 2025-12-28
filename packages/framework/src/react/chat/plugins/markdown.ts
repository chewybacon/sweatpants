/**
 * plugins/markdown.ts
 *
 * Markdown plugin - parses settled content to HTML using marked.
 *
 * This is the foundational processor plugin. Most other plugins depend on it
 * to handle text outside of code fences.
 */
import { marked } from 'marked'
import type { ProcessorPlugin } from './types'
import type { Processor, ProcessorEmit, ProcessorContext } from '../types'

/**
 * Markdown processor implementation.
 *
 * Parses the full accumulated content (not just the chunk) to HTML.
 * This ensures proper parsing of multi-paragraph markdown.
 */
function createMarkdownProcessor(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // marked.parse is synchronous when async option is not set
    const html = marked.parse(ctx.next, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Markdown plugin.
 *
 * Parses settled content to HTML using marked.
 * This is the base plugin that most streaming content needs.
 *
 * @example
 * ```typescript
 * import { markdownPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [markdownPlugin]
 * })
 * ```
 */
export const markdownPlugin: ProcessorPlugin = {
  name: 'markdown',
  description: 'Parse markdown to HTML using marked',
  settler: 'paragraph',
  processor: createMarkdownProcessor,
}

/**
 * Smart markdown processor implementation.
 *
 * Context-aware markdown parsing that uses settler metadata:
 * - Inside code fences: skips markdown parsing (code is handled separately)
 * - Outside code fences: parses as normal markdown
 *
 * Best used with the codeFence() settler.
 */
function createSmartMarkdownProcessor(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // Inside code fences, just pass through raw
    if (ctx.meta?.inCodeFence) {
      yield* emit({ raw: ctx.chunk })
      return
    }

    // Outside code fences, parse as markdown
    const html = marked.parse(ctx.next, { async: false }) as string
    yield* emit({
      raw: ctx.next,
      html,
    })
  }
}

/**
 * Smart markdown plugin.
 *
 * Like markdownPlugin but skips content inside code fences.
 * Use this when you have a separate syntax highlighting plugin.
 *
 * @example
 * ```typescript
 * import { smartMarkdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [smartMarkdownPlugin, shikiPlugin]
 * })
 * ```
 */
export const smartMarkdownPlugin: ProcessorPlugin = {
  name: 'smart-markdown',
  description: 'Parse markdown to HTML, skip code fences',
  settler: 'paragraph',
  processor: createSmartMarkdownProcessor,
}
