/**
 * shiki/settlers.ts
 * 
 * Code fence-aware settlers for progressive syntax highlighting.
 * 
 * These settlers understand markdown code fences and yield content
 * with metadata that processors can use to apply appropriate handling:
 * - Inside fence: Apply syntax highlighting
 * - Outside fence: Apply markdown parsing
 * 
 * ## The Code Fence Settler Strategy
 * 
 * We settle line-by-line while tracking fence state:
 * 
 * ```
 * Input:   "Here's code:\n```python\ndef foo():\n    return 42\n```\nDone!"
 *          
 * Yields:  
 *   1. { content: "Here's code:\n", meta: { inCodeFence: false } }
 *   2. { content: "```python\n", meta: { inCodeFence: true, language: "python", fenceStart: true } }
 *   3. { content: "def foo():\n", meta: { inCodeFence: true, language: "python" } }
 *   4. { content: "    return 42\n", meta: { inCodeFence: true, language: "python" } }
 *   5. { content: "```\n", meta: { inCodeFence: true, language: "python", fenceEnd: true } }
 *   6. { content: "Done!", meta: { inCodeFence: false } }
 * ```
 * 
 * The processor can then:
 * - Accumulate code lines when inside fence
 * - Quick-highlight each line as it arrives
 * - Full Shiki highlight when fenceEnd: true
 */
import type { SettleContext, SettleResult, MetadataSettler, SettleMeta } from '../types'

// Regex to detect fence start: ``` or ~~~ with optional language
const FENCE_START_REGEX = /^(`{3,}|~{3,})(\w*)\s*$/
// Regex to detect fence end: matching ``` or ~~~
const FENCE_END_REGEX = /^(`{3,}|~{3,})\s*$/

export interface CodeFenceMeta extends SettleMeta {
  /** Whether we're inside a code fence */
  inCodeFence: boolean
  /** The language of the current fence (e.g., "python", "typescript") */
  language?: string
  /** The fence delimiter being used (``` or ~~~) */
  fenceDelimiter?: string
  /** True if this is the opening line of a fence */
  fenceStart?: boolean
  /** True if this is the closing line of a fence */
  fenceEnd?: boolean
  /** The complete code content (only set when fenceEnd is true) */
  codeContent?: string
}

/**
 * Code fence settler - settles line by line with fence awareness.
 * 
 * This settler:
 * 1. Settles complete lines (ending with \n)
 * 2. Tracks whether we're inside a code fence
 * 3. Attaches metadata about fence state to each yield
 * 4. When a fence closes, includes the complete code content for full highlighting
 * 
 * @example
 * ```typescript
 * dualBufferTransform({
 *   settler: codeFence(),
 *   processor: shikiProcessor(),
 * })
 * ```
 */
export function codeFence(): MetadataSettler {
  // State persists across calls (closure)
  let inFence = false
  let fenceDelimiter = ''
  let language = ''
  let accumulatedCode = ''

  return function* (ctx: SettleContext): Iterable<SettleResult> {
    const { pending, flush } = ctx
    let remaining = pending
    let position = 0

    while (position < remaining.length) {
      // Find the next newline
      const newlineIdx = remaining.indexOf('\n', position)
      
      if (newlineIdx === -1) {
        // No complete line yet
        
        // If flush is true, we need to handle incomplete content at stream end
        if (flush) {
          const content = remaining.slice(position)
          
          if (inFence) {
            // Check if this looks like a fence close (``` with optional whitespace)
            const trimmed = content.trim()
            const isClosingFence = FENCE_END_REGEX.test(trimmed) &&
              fenceDelimiter.length > 0 && trimmed.startsWith(fenceDelimiter[0]!) &&
              trimmed.length >= fenceDelimiter.length
            
            if (isClosingFence) {
              // It's a fence close without trailing newline (OpenAI behavior)
              yield {
                content,
                meta: {
                  inCodeFence: true,
                  language: language || undefined,
                  fenceDelimiter,
                  fenceEnd: true,
                  codeContent: accumulatedCode,
                } as CodeFenceMeta,
              }
              
              // Reset fence state
              inFence = false
              fenceDelimiter = ''
              language = ''
              accumulatedCode = ''
            } else {
              // It's incomplete code content - settle it with fence metadata
              accumulatedCode += content
              yield {
                content,
                meta: {
                  inCodeFence: true,
                  language: language || undefined,
                  fenceDelimiter,
                } as CodeFenceMeta,
              }
            }
          } else {
            // Outside fence - just settle remaining content
            yield {
              content,
              meta: { inCodeFence: false } as CodeFenceMeta,
            }
          }
          position = remaining.length
        }
        
        // Not flushing - leave incomplete content in pending
        break
      }

      // Extract the complete line (including \n)
      const line = remaining.slice(position, newlineIdx + 1)
      const lineContent = line.trimEnd() // For matching, ignore trailing whitespace

      // Check for fence transitions
      if (!inFence) {
        // Look for fence start
        const startMatch = lineContent.match(FENCE_START_REGEX)
        if (startMatch) {
          // Entering a fence
          inFence = true
          fenceDelimiter = startMatch[1]!
          language = startMatch[2] || ''
          accumulatedCode = ''

          yield {
            content: line,
            meta: {
              inCodeFence: true,
              language: language || undefined,
              fenceDelimiter,
              fenceStart: true,
            } as CodeFenceMeta,
          }
          position = newlineIdx + 1
          continue
        }

        // Regular line outside fence
        yield {
          content: line,
          meta: { inCodeFence: false } as CodeFenceMeta,
        }
      } else {
        // We're inside a fence - check for fence end
        const endMatch = lineContent.match(FENCE_END_REGEX)
        const isClosingFence = endMatch && endMatch[1] && fenceDelimiter.length > 0 && endMatch[1].startsWith(fenceDelimiter[0]!) && endMatch[1].length >= fenceDelimiter.length

        if (isClosingFence) {
          // Closing the fence - include accumulated code for full highlighting
          yield {
            content: line,
            meta: {
              inCodeFence: true,
              language: language || undefined,
              fenceDelimiter,
              fenceEnd: true,
              codeContent: accumulatedCode,
            } as CodeFenceMeta,
          }

          // Reset fence state
          inFence = false
          fenceDelimiter = ''
          language = ''
          accumulatedCode = ''
        } else {
          // Regular line inside fence - accumulate and yield
          accumulatedCode += line

          yield {
            content: line,
            meta: {
              inCodeFence: true,
              language: language || undefined,
              fenceDelimiter,
            } as CodeFenceMeta,
          }
        }
      }

      position = newlineIdx + 1
    }

    // Note: Any remaining content without a newline stays in pending
    // unless flush: true was set, in which case it was handled above
  }
}

/**
 * Simple line settler - settles on each newline, no fence awareness.
 * 
 * Use this for simpler cases where you just want line-by-line settling
 * without code fence detection.
 */
export function line(): MetadataSettler {
  return function* (ctx: SettleContext): Iterable<SettleResult> {
    const { pending } = ctx
    let position = 0

    while (position < pending.length) {
      const newlineIdx = pending.indexOf('\n', position)
      if (newlineIdx === -1) break

      const lineContent = pending.slice(position, newlineIdx + 1)
      yield { content: lineContent }
      position = newlineIdx + 1
    }
  }
}
