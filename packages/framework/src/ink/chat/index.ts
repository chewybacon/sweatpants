/**
 * ink/chat/index.ts
 *
 * Ink (terminal) adapter for the TanStack Framework chat system.
 *
 * This module provides React hooks and components for building
 * terminal-based chat UIs using Ink.
 *
 * ## Usage
 *
 * ```tsx
 * import { InkChatProvider, useInkChat } from '@tanstack/framework/ink/chat'
 * import { Box, Text } from 'ink'
 *
 * function App() {
 *   return (
 *     <InkChatProvider customFetch={devServer.fetch}>
 *       <ChatUI />
 *     </InkChatProvider>
 *   )
 * }
 *
 * function ChatUI() {
 *   const { messages, isStreaming, send } = useInkChat({
 *     pipeline: { processors: [terminalMarkdown, terminalCode] },
 *   })
 *
 *   return (
 *     <Box flexDirection="column">
 *       {messages.map(msg => (
 *         <Box key={msg.id}>
 *           <Text bold>{msg.role}: </Text>
 *           <Text>{msg.content}</Text>
 *         </Box>
 *       ))}
 *       {isStreaming && <Text dimColor>Thinking...</Text>}
 *     </Box>
 *   )
 * }
 * ```
 */

// =============================================================================
// HOOKS
// =============================================================================

export { useInkChat } from './useInkChat'
export type { UseInkChatOptions, UseInkChatReturn } from './useInkChat'

// =============================================================================
// PROVIDERS
// =============================================================================

export {
  InkChatProvider,
  useInkChatConfig,
} from './InkChatProvider'
export type {
  InkChatConfig,
  ResolvedInkChatConfig,
  InkChatProviderProps,
  CustomFetchFn,
} from './InkChatProvider'

// =============================================================================
// TYPES
// =============================================================================

export type {
  InkChatEmission,
  InkChatToolCall,
  InkChatMessage,
  InkStreamingMessage,
  Frame,
  MessagePart,
  ChatState,
  PendingClientToolState,
  PendingHandoffState,
  ToolEmissionTrackingState,
  PendingHandoff,
} from './types'

// =============================================================================
// RE-EXPORTS FROM CORE
// =============================================================================

// Pipeline utilities that work with terminal processors
export {
  createPipeline,
  createPipelineTransform,
  emptyFrame,
  renderFrameToRendered,
  renderFrameToRaw,
} from '../../react/chat/pipeline'

export type {
  Pipeline,
  PipelineConfig,
  Processor,
  Block,
  BlockType,
  BlockStatus,
  RenderPass,
} from '../../react/chat/pipeline'
