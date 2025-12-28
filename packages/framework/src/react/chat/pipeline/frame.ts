/**
 * pipeline/frame.ts
 *
 * Utilities for creating and updating Frames immutably.
 *
 * These are the core building blocks for settlers and processors.
 * All functions are pure - they return new objects rather than mutating.
 */
import type {
  Frame,
  Block,
  BlockType,
  BlockStatus,
  RenderPass,
  TraceEntry,
  TraceAction,
  Annotation,
} from './types'

// =============================================================================
// ID Generation
// =============================================================================

let frameCounter = 0
let blockCounter = 0

/**
 * Generate a unique frame ID.
 */
export const generateFrameId = (): string => `frame-${++frameCounter}`

/**
 * Generate a unique block ID.
 */
export const generateBlockId = (): string => `block-${++blockCounter}`

/**
 * Reset ID counters (for testing).
 */
export const resetIdCounters = (): void => {
  frameCounter = 0
  blockCounter = 0
}

// =============================================================================
// Frame Creation
// =============================================================================

/**
 * Create an empty frame (starting point for a new stream).
 */
export const emptyFrame = (): Frame => ({
  id: generateFrameId(),
  blocks: [],
  timestamp: Date.now(),
  trace: [],
  activeBlockIndex: null,
})

/**
 * Create a new frame from an existing frame with updates.
 */
export const updateFrame = (
  frame: Frame,
  updates: Partial<Omit<Frame, 'id'>>
): Frame => ({
  ...frame,
  ...updates,
  id: generateFrameId(), // New frame gets new ID
  timestamp: Date.now(),
})

// =============================================================================
// Block Creation
// =============================================================================

/**
 * Options for creating a new block.
 */
export interface CreateBlockOptions {
  type: BlockType
  raw?: string
  html?: string
  status?: BlockStatus
  renderPass?: RenderPass
  language?: string
  meta?: Record<string, unknown>
}

/**
 * Create a new block with sensible defaults.
 */
export const createBlock = (options: CreateBlockOptions): Block => ({
  id: generateBlockId(),
  type: options.type,
  raw: options.raw ?? '',
  html: options.html ?? '',
  status: options.status ?? 'streaming',
  renderPass: options.renderPass ?? 'none',
  ...(options.language !== undefined && { language: options.language }),
  ...(options.meta !== undefined && { meta: options.meta }),
})

/**
 * Create a text block.
 */
export const createTextBlock = (raw: string = '', status: BlockStatus = 'streaming'): Block =>
  createBlock({ type: 'text', raw, status })

/**
 * Create a code block.
 */
export const createCodeBlock = (
  language: string = '',
  raw: string = '',
  status: BlockStatus = 'streaming'
): Block =>
  createBlock({ type: 'code', raw, status, language })

// =============================================================================
// Block Updates (Immutable)
// =============================================================================

/**
 * Update a block immutably.
 */
export const updateBlock = (
  block: Block,
  updates: Partial<Omit<Block, 'id' | 'type'>>
): Block => ({
  ...block,
  ...updates,
})

/**
 * Append raw content to a block.
 */
export const appendToBlock = (block: Block, content: string): Block => ({
  ...block,
  raw: block.raw + content,
})

/**
 * Mark a block as complete.
 */
export const completeBlock = (block: Block): Block => ({
  ...block,
  status: 'complete',
})

/**
 * Set HTML on a block with a render pass.
 */
export const setBlockHtml = (
  block: Block,
  html: string,
  renderPass: RenderPass
): Block => ({
  ...block,
  html,
  renderPass,
})

/**
 * Add an annotation to a block.
 */
export const addAnnotation = (block: Block, annotation: Annotation): Block => ({
  ...block,
  annotations: [...(block.annotations ?? []), annotation],
})

/**
 * Add multiple annotations to a block.
 */
export const addAnnotations = (block: Block, annotations: readonly Annotation[]): Block => ({
  ...block,
  annotations: [...(block.annotations ?? []), ...annotations],
})

// =============================================================================
// Frame Block Operations (Immutable)
// =============================================================================

/**
 * Add a block to the frame.
 */
export const addBlock = (frame: Frame, block: Block): Frame =>
  updateFrame(frame, {
    blocks: [...frame.blocks, block],
    activeBlockIndex: frame.blocks.length, // New block is now active
  })

/**
 * Update a specific block in the frame by index.
 */
export const updateBlockAt = (
  frame: Frame,
  index: number,
  updater: (block: Block) => Block
): Frame => {
  if (index < 0 || index >= frame.blocks.length) {
    return frame // Index out of bounds, return unchanged
  }

  return updateFrame(frame, {
    blocks: frame.blocks.map((b, i) => (i === index ? updater(b) : b)),
  })
}

/**
 * Update a specific block in the frame by ID.
 */
export const updateBlockById = (
  frame: Frame,
  blockId: string,
  updater: (block: Block) => Block
): Frame =>
  updateFrame(frame, {
    blocks: frame.blocks.map((b) => (b.id === blockId ? updater(b) : b)),
  })

/**
 * Update the currently active block (if any).
 */
export const updateActiveBlock = (
  frame: Frame,
  updater: (block: Block) => Block
): Frame => {
  if (frame.activeBlockIndex === null) {
    return frame
  }
  return updateBlockAt(frame, frame.activeBlockIndex, updater)
}

/**
 * Get the currently active block (if any).
 */
export const getActiveBlock = (frame: Frame): Block | null => {
  if (frame.activeBlockIndex === null) {
    return null
  }
  return frame.blocks[frame.activeBlockIndex] ?? null
}

/**
 * Get the last block (if any).
 */
export const getLastBlock = (frame: Frame): Block | null =>
  frame.blocks.length > 0 ? frame.blocks[frame.blocks.length - 1]! : null

/**
 * Set the active block index.
 */
export const setActiveBlock = (frame: Frame, index: number | null): Frame =>
  updateFrame(frame, { activeBlockIndex: index })

/**
 * Clear the active block (no block is streaming).
 */
export const clearActiveBlock = (frame: Frame): Frame =>
  setActiveBlock(frame, null)

// =============================================================================
// Trace Operations
// =============================================================================

/**
 * Add a trace entry to a frame.
 */
export const addTrace = (
  frame: Frame,
  processor: string,
  action: TraceAction,
  options: {
    blockId?: string
    detail?: string
    durationMs?: number
  } = {}
): Frame =>
  updateFrame(frame, {
    trace: [
      ...frame.trace,
      {
        processor,
        action,
        timestamp: Date.now(),
        ...options,
      },
    ],
  })

/**
 * Create a trace entry without adding it to a frame.
 */
export const createTrace = (
  processor: string,
  action: TraceAction,
  options: {
    blockId?: string
    detail?: string
    durationMs?: number
  } = {}
): TraceEntry => ({
  processor,
  action,
  timestamp: Date.now(),
  ...options,
})

// =============================================================================
// Frame Queries
// =============================================================================

/**
 * Check if a frame has any blocks.
 */
export const hasBlocks = (frame: Frame): boolean => frame.blocks.length > 0

/**
 * Check if a frame has any streaming blocks.
 */
export const hasStreamingBlocks = (frame: Frame): boolean =>
  frame.blocks.some((b) => b.status === 'streaming')

/**
 * Get all blocks of a specific type.
 */
export const getBlocksByType = (frame: Frame, type: BlockType): readonly Block[] =>
  frame.blocks.filter((b) => b.type === type)

/**
 * Get all code blocks.
 */
export const getCodeBlocks = (frame: Frame): readonly Block[] =>
  getBlocksByType(frame, 'code')

/**
 * Get all text blocks.
 */
export const getTextBlocks = (frame: Frame): readonly Block[] =>
  getBlocksByType(frame, 'text')

/**
 * Find a block by ID.
 */
export const findBlockById = (frame: Frame, blockId: string): Block | null =>
  frame.blocks.find((b) => b.id === blockId) ?? null

/**
 * Get blocks that need processing (incomplete render pass).
 */
export const getBlocksNeedingRender = (
  frame: Frame,
  targetPass: RenderPass
): readonly Block[] => {
  const passOrder: RenderPass[] = ['none', 'quick', 'full']
  const targetIndex = passOrder.indexOf(targetPass)

  return frame.blocks.filter((b) => {
    const currentIndex = passOrder.indexOf(b.renderPass)
    return currentIndex < targetIndex
  })
}

// =============================================================================
// Frame Rendering
// =============================================================================

/**
 * Render a frame to a single HTML string.
 * Concatenates all block HTML in order.
 */
export const renderFrameToHtml = (frame: Frame): string =>
  frame.blocks.map((b) => b.html).join('')

/**
 * Render a frame to raw text.
 * Concatenates all block raw content in order.
 */
export const renderFrameToRaw = (frame: Frame): string =>
  frame.blocks.map((b) => b.raw).join('')
