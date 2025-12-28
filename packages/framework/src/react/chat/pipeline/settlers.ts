/**
 * pipeline/settlers.ts
 *
 * Settlers parse raw streaming tokens into Frame block structure.
 *
 * A settler's job is purely structural:
 * - Create new blocks (text/code)
 * - Track code fence boundaries
 * - Determine when blocks are complete vs streaming
 *
 * Settlers do NOT render HTML - that's the processors' job.
 *
 * ## Code Fence Detection
 *
 * The primary complexity is detecting markdown code fences:
 * - Opening: ```language or ~~~language
 * - Closing: ``` or ~~~
 * - Content between is code, not markdown
 */
import type { Settler, SettlerFactory, SettleContext, Frame, Block } from './types'
import {
  emptyFrame,
  updateFrame,
  createTextBlock,
  createCodeBlock,
  addBlock,
  updateActiveBlock,
  getActiveBlock,
  getLastBlock,
  appendToBlock,
  completeBlock,
  clearActiveBlock,
  addTrace,
  setActiveBlock,
} from './frame'

// =============================================================================
// Fence Detection
// =============================================================================

/** Regex to detect fence start: ``` or ~~~ with optional language */
const FENCE_START = /^(`{3,}|~{3,})(\w*)\s*$/

/** Regex to detect fence end: ``` or ~~~ */
const FENCE_END = /^(`{3,}|~{3,})\s*$/

/**
 * Check if a line is a fence start.
 * Returns [delimiter, language] or null.
 */
const matchFenceStart = (line: string): [string, string] | null => {
  const match = line.trim().match(FENCE_START)
  if (match) {
    return [match[1]!, match[2] || '']
  }
  return null
}

/**
 * Check if a line is a fence end for a given delimiter.
 */
const matchFenceEnd = (line: string, delimiter: string): boolean => {
  const trimmed = line.trim()
  const match = trimmed.match(FENCE_END)
  if (!match) return false

  // Must use same fence character and at least same length
  const fence = match[1]!
  return fence[0] === delimiter[0] && fence.length >= delimiter.length
}

// =============================================================================
// Code Fence Settler
// =============================================================================

/**
 * Internal state for the code fence settler.
 */
interface FenceState {
  /** Are we currently inside a code fence? */
  inFence: boolean
  /** The fence delimiter (``` or ~~~) */
  delimiter: string
  /** The language of the current fence */
  language: string
  /** Buffer for incomplete line */
  lineBuffer: string
}

/**
 * Create a code fence settler.
 *
 * This settler:
 * - Processes content line-by-line
 * - Creates text blocks for content outside fences
 * - Creates code blocks for content inside fences
 * - Tracks fence state across chunks
 *
 * The result is a Frame with properly structured blocks that
 * processors can then enhance with HTML.
 */
export const createCodeFenceSettler: SettlerFactory = () => {
  // State persists across calls
  const state: FenceState = {
    inFence: false,
    delimiter: '',
    language: '',
    lineBuffer: '',
  }

  const settler: Settler = (frame: Frame, chunk: string, ctx: SettleContext): Frame => {
    let currentFrame = frame

    // Add chunk to line buffer
    state.lineBuffer += chunk

    // Process complete lines
    while (true) {
      const newlineIdx = state.lineBuffer.indexOf('\n')

      if (newlineIdx === -1) {
        // No complete line yet
        if (ctx.flush && state.lineBuffer.length > 0) {
          // End of stream - process remaining content
          currentFrame = processContent(currentFrame, state.lineBuffer, state, true)
          state.lineBuffer = ''
        }
        break
      }

      // Extract the complete line (including \n)
      const line = state.lineBuffer.slice(0, newlineIdx + 1)
      state.lineBuffer = state.lineBuffer.slice(newlineIdx + 1)

      // Process this line
      currentFrame = processLine(currentFrame, line, state)
    }

    return currentFrame
  }

  return settler
}

/**
 * Process a complete line (with trailing newline).
 */
function processLine(frame: Frame, line: string, state: FenceState): Frame {
  const lineContent = line.trimEnd() // For matching (keep original for raw)

  if (!state.inFence) {
    // Outside fence - check for fence start
    const fenceStart = matchFenceStart(lineContent)

    if (fenceStart) {
      const [delimiter, language] = fenceStart

      // Complete any current text block
      let currentFrame = completeCurrentTextBlock(frame)

      // Enter fence mode
      state.inFence = true
      state.delimiter = delimiter
      state.language = language

      // Create new code block
      const codeBlock = createCodeBlock(language, '', 'streaming')
      currentFrame = addBlock(currentFrame, codeBlock)
      currentFrame = addTrace(currentFrame, 'settler', 'create', {
        blockId: codeBlock.id,
        detail: `code fence start: ${language || 'no language'}`,
      })

      return currentFrame
    }

    // Regular text line - append to current text block
    return appendTextContent(frame, line, state)
  } else {
    // Inside fence - check for fence end
    if (matchFenceEnd(lineContent, state.delimiter)) {
      // Exit fence mode
      state.inFence = false
      state.delimiter = ''
      state.language = ''

      // Complete the code block
      const currentFrame = updateActiveBlock(frame, completeBlock)
      return addTrace(currentFrame, 'settler', 'update', {
        blockId: getActiveBlock(currentFrame)?.id,
        detail: 'code fence end',
      })
    }

    // Regular code line - append to current code block
    return updateActiveBlock(frame, (block) => appendToBlock(block, line))
  }
}

/**
 * Process content that may not be a complete line (for flush).
 */
function processContent(
  frame: Frame,
  content: string,
  state: FenceState,
  isFlush: boolean
): Frame {
  if (!content) return frame

  if (!state.inFence) {
    // Text content
    return appendTextContent(frame, content, state)
  } else {
    // Code content
    let currentFrame = updateActiveBlock(frame, (block) => appendToBlock(block, content))

    // If flushing, check if this looks like a fence close
    if (isFlush) {
      const trimmed = content.trim()
      if (matchFenceEnd(trimmed, state.delimiter)) {
        state.inFence = false
        state.delimiter = ''
        state.language = ''
        currentFrame = updateActiveBlock(currentFrame, completeBlock)
      }
    }

    return currentFrame
  }
}

/**
 * Append text content to the current text block, or create one if needed.
 */
function appendTextContent(frame: Frame, content: string, state: FenceState): Frame {
  const lastBlock = getLastBlock(frame)

  // If last block is a streaming text block, append to it
  if (lastBlock?.type === 'text' && lastBlock.status === 'streaming') {
    return updateActiveBlock(frame, (block) => appendToBlock(block, content))
  }

  // Otherwise, create a new text block
  const textBlock = createTextBlock(content, 'streaming')
  let currentFrame = addBlock(frame, textBlock)
  currentFrame = addTrace(currentFrame, 'settler', 'create', {
    blockId: textBlock.id,
    detail: 'text block',
  })

  return currentFrame
}

/**
 * Complete the current text block if there is one.
 */
function completeCurrentTextBlock(frame: Frame): Frame {
  const activeBlock = getActiveBlock(frame)

  if (activeBlock?.type === 'text' && activeBlock.status === 'streaming') {
    const updated = updateActiveBlock(frame, completeBlock)
    return clearActiveBlock(updated)
  }

  return frame
}

// =============================================================================
// Simple Line Settler (Alternative)
// =============================================================================

/**
 * Create a simple line-by-line settler.
 *
 * This settler treats everything as text blocks, settling line by line.
 * Useful for plain text or when code fence detection isn't needed.
 */
export const createLineSettler: SettlerFactory = () => {
  let lineBuffer = ''

  return (frame: Frame, chunk: string, ctx: SettleContext): Frame => {
    let currentFrame = frame
    lineBuffer += chunk

    while (true) {
      const newlineIdx = lineBuffer.indexOf('\n')

      if (newlineIdx === -1) {
        if (ctx.flush && lineBuffer.length > 0) {
          currentFrame = appendTextContent(currentFrame, lineBuffer, { inFence: false, delimiter: '', language: '', lineBuffer: '' })
          lineBuffer = ''
        }
        break
      }

      const line = lineBuffer.slice(0, newlineIdx + 1)
      lineBuffer = lineBuffer.slice(newlineIdx + 1)

      currentFrame = appendTextContent(currentFrame, line, { inFence: false, delimiter: '', language: '', lineBuffer: '' })
    }

    return currentFrame
  }
}

// =============================================================================
// Default Export
// =============================================================================

/**
 * Default settler: code fence aware.
 */
export const defaultSettler = createCodeFenceSettler
