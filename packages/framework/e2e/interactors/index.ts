/**
 * E2E Interactors
 *
 * Custom interactors for testing chat UI components.
 * These provide a clean, declarative API for UI assertions and actions.
 *
 * @example
 * ```typescript
 * import { ChatSession, Message, ToolCall, including } from '../interactors/index.ts'
 *
 * // Check session state
 * await ChatSession().has({ isStreaming: false, messageCount: 2 })
 *
 * // Send a message
 * await ChatSession().sendMessage('Hello!')
 *
 * // Wait for assistant response
 * await Message({ role: 'assistant' }).exists()
 *
 * // Check message content
 * await Message({ role: 'assistant' }).has({ content: including('Hello') })
 *
 * // Check tool call completed
 * await ToolCall({ toolName: 'get_weather' }).has({ state: 'completed' })
 * ```
 */

// Chat session interactor
export { ChatSession } from './chat-session.ts'

// Message interactors
export { Message, UserMessage, AssistantMessage, including } from './message.ts'

// Tool call interactors
export {
  ToolCall,
  PendingToolCall,
  RunningToolCall,
  CompletedToolCall,
  EmissionToolCall,
  type ToolCallState,
} from './tool-call.ts'

// Re-export common interactor utilities from @interactors/html
export {
  Button,
  TextField,
  Heading,
  HTML,
  Link,
  CheckBox,
  Select,
  setDocumentResolver,
  setInteractorTimeout,
  matching,
  and,
  or,
  not,
  some,
  every,
} from '@interactors/html'
