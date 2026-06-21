/**
 * pipeline/parser.ts
 *
 * Internal parser for the streaming pipeline.
 *
 * The parser is responsible for converting raw streaming text into
 * a Frame with properly structured blocks. It handles:
 *
 * - Code fence detection (``` and ~~~)
 * - Block creation (text vs code)
 * - Streaming vs complete status
 *
 * This is an INTERNAL module - not part of the public API.
 * Users don't need to think about parsing; they just write processors.
 *
 * ## Code Fence Detection
 *
 * The parser detects markdown code fences:
 * - Opening: ```language or ~~~language
 * - Closing: ``` or ~~~
 * - Content between is a code block, not text
 */
import type { Parser, ParserFactory, ParseContext, Frame } from './types.ts'
import {
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
} from './frame.ts'

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
// Parser State
// =============================================================================

/**
 * Internal state for the parser.
 */
interface ParserState {
  /** Are we currently inside a code fence? */
  inFence: boolean
  /** The fence delimiter (``` or ~~~) */
  delimiter: string
  /** The language of the current fence */
  language: string
  /** Buffer for incomplete line */
  lineBuffer: string
}

// =============================================================================
// Parser Implementation
// =============================================================================

/**
 * Create the internal parser.
 *
 * This parser:
 * - Processes content line-by-line
 * - Creates text blocks for content outside fences
 * - Creates code blocks for content inside fences
 * - Tracks fence state across chunks
 *
 * @internal
 */
export const createParser: ParserFactory = () => {
  // State persists across calls
  const state: ParserState = {
    inFence: false,
    delimiter: '',
    language: '',
    lineBuffer: '',
  }

  const parser: Parser = (frame: Frame, chunk: string, ctx: ParseContext): Frame => {
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

  return parser
}

/**
 * Process a complete line (with trailing newline).
 */
function processLine(frame: Frame, line: string, state: ParserState): Frame {
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
      currentFrame = addTrace(currentFrame, 'parser', 'create', {
        blockId: codeBlock.id,
        detail: `code fence start: ${language || 'plain'}`,
      })

      return currentFrame
    }

    // Regular text line - append to current text block
    return appendTextContent(frame, line)
  } else {
    // Inside fence - check for fence end
    if (matchFenceEnd(lineContent, state.delimiter)) {
      // Exit fence mode
      state.inFence = false
      state.delimiter = ''
      state.language = ''

      // Complete the code block
      const currentFrame = updateActiveBlock(frame, completeBlock)
      const activeBlock = getActiveBlock(currentFrame)
      return addTrace(currentFrame, 'parser', 'update', {
        ...(activeBlock && { blockId: activeBlock.id }),
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
  state: ParserState,
  isFlush: boolean
): Frame {
  if (!content) return frame

  if (!state.inFence) {
    // Text content
    return appendTextContent(frame, content)
  } else {
    // Code content - but first check if this is a fence close (on flush)
    // We need to check BEFORE appending to avoid including the fence in raw content
    if (isFlush) {
      const trimmed = content.trim()
      if (matchFenceEnd(trimmed, state.delimiter)) {
        // This is a fence close - don't append it, just close the fence
        state.inFence = false
        state.delimiter = ''
        state.language = ''
        return updateActiveBlock(frame, completeBlock)
      }
    }
    
    // Not a fence close - append the content
    return updateActiveBlock(frame, (block) => appendToBlock(block, content))
  }
}

/**
 * Append text content to the current text block, or create one if needed.
 */
function appendTextContent(frame: Frame, content: string): Frame {
  const lastBlock = getLastBlock(frame)

  // If last block is a streaming text block, append to it
  if (lastBlock?.type === 'text' && lastBlock.status === 'streaming') {
    return updateActiveBlock(frame, (block) => appendToBlock(block, content))
  }

  // Otherwise, create a new text block
  const textBlock = createTextBlock(content, 'streaming')
  let currentFrame = addBlock(frame, textBlock)
  currentFrame = addTrace(currentFrame, 'parser', 'create', {
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
// Default Export
// =============================================================================

/**
 * Default parser factory.
 * @internal
 */
export const defaultParser = createParser
