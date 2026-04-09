/**
 * Isomorphic Tool Executor
 *
 * Handles execution of isomorphic tools with server-first flow.
 *
 * KEY PRINCIPLE: Server's return value is ALWAYS the final result to the LLM.
 *
 * ## SERVER-FIRST - Simple (e.g., celebrate)
 * 1. LLM calls tool → Server receives call
 * 2. Server executes tool.server(params) → returns serverOutput
 * 3. Server sends handoff to client with serverOutput
 * 4. Client executes tool.client(serverOutput) for side effects (UI, etc.)
 * 5. Client RE-INITIATES chat (server result is already determined)
 * 6. Server's original return value goes to LLM
 *
 * ## SERVER-FIRST - With Handoff (V7 Pattern)
 * 1. LLM calls tool → Server receives call
 * 2. Server executes tool.server(params, ctx) in PHASE 1
 *    - ctx.handoff({ before, after }) runs before(), halts at handoff point
 *    - Handoff data sent to client
 * 3. Client executes tool.client(handoffData) → returns clientOutput
 * 4. Client RE-INITIATES chat with clientOutput
 * 5. Server executes tool.server(params, ctx) in PHASE 2
 *    - ctx.handoff() skips before(), runs after(handoff, clientOutput)
 * 6. Server's after() return value goes to LLM
 *
 */
import type { IsomorphicToolResult } from './types.ts'
import { messageIdForTool } from '../session/message-identity.ts'
export { executeServerPart, executeServerPhase2 } from './server-executor.ts'
export { executeClientPart, executeIsomorphicToolsClient } from './client-executor.ts'
export {
  executeIsomorphicToolsClientWithReactHandlers,
  type ReactHandlerExecutionOptions,
} from './react-executor.ts'

// --- Tool Result Message Formatting ---

/**
 * Format isomorphic tool result for LLM re-initiation.
 */
export function formatIsomorphicToolResult(
  result: IsomorphicToolResult
): { id: string; role: 'tool'; tool_call_id: string; content: string } {
  return {
    id: messageIdForTool(result.callId),
    role: 'tool',
    tool_call_id: result.callId,
    content: result.ok ? result.content! : `Error: ${result.error}`,
  }
}
