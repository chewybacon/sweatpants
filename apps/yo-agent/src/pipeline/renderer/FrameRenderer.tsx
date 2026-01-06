/**
 * FrameRenderer
 *
 * Renders a Frame to Ink components for terminal display.
 *
 * The Frame's blocks contain pre-processed ANSI-styled content in their
 * `rendered` field. This component just displays them with proper layout.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { Frame, Block } from '@sweatpants/framework/react/chat/pipeline'

// =============================================================================
// Block Renderer
// =============================================================================

interface BlockRendererProps {
  block: Block
}

/**
 * Render a single block.
 *
 * Uses the pre-processed `rendered` field which contains ANSI-styled text.
 * Falls back to raw content if not yet processed.
 */
function BlockRenderer({ block }: BlockRendererProps) {
  // Use rendered content if available, otherwise fall back to raw
  const content = block.rendered || block.raw

  if (block.type === 'code') {
    // Code blocks get a visual container with language label
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        marginBottom={1}
      >
        {block.language && (
          <Text color="gray" dimColor>[{block.language}]</Text>
        )}
        <Box
          paddingLeft={1}
          paddingRight={1}
          borderStyle="round"
          borderColor="gray"
        >
          <Text>{content}</Text>
        </Box>
      </Box>
    )
  }

  // Text blocks render directly
  return (
    <Box marginBottom={1}>
      <Text wrap="wrap">{content}</Text>
    </Box>
  )
}

// =============================================================================
// Frame Renderer
// =============================================================================

interface FrameRendererProps {
  /** The frame to render */
  frame: Frame
  /** Whether content is still streaming */
  isStreaming?: boolean
}

/**
 * Render a complete Frame to Ink components.
 *
 * Iterates through blocks and renders each one appropriately.
 */
export function FrameRenderer({ frame, isStreaming = false }: FrameRendererProps) {
  if (frame.blocks.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      {frame.blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </Box>
  )
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Get a plain text representation of a frame (for accessibility, copy, etc.)
 */
export function frameToPlainText(frame: Frame): string {
  return frame.blocks.map((b) => b.raw).join('\n\n')
}

/**
 * Get the rendered ANSI text from a frame.
 */
export function frameToAnsi(frame: Frame): string {
  return frame.blocks.map((b) => b.rendered || b.raw).join('\n\n')
}
