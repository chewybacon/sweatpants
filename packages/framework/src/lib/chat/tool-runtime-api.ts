/**
 * tool-runtime-api.ts
 *
 * Extensible tool runtime API using Effectionx context-api.
 * Allows tool execution to be wrapped with middleware for extensibility.
 *
 * This enables third-party libraries to add logging, caching, retry logic,
 * monitoring, and other cross-cutting concerns to tool execution.
 */
import { createApi } from '@effectionx/context-api'
import type { Operation } from 'effection'
import type { AnyIsomorphicTool, IsomorphicToolResult } from './isomorphic-tools/types'

// Define the tool runtime operations interface
interface ToolRuntimeOperations {
  executeTool(tool: AnyIsomorphicTool, params: unknown): Operation<IsomorphicToolResult>
  validateToolParams(tool: AnyIsomorphicTool, params: unknown): Operation<void>
  handleToolError(tool: AnyIsomorphicTool, error: Error, params: unknown): Operation<IsomorphicToolResult>
  logToolExecution(tool: AnyIsomorphicTool, params: unknown, result: IsomorphicToolResult): Operation<void>
}

// Create the extensible tool runtime API
const toolRuntimeApi = createApi<ToolRuntimeOperations>(
  'tool-runtime',
  {
    *executeTool(_tool: AnyIsomorphicTool, _params: unknown): Operation<IsomorphicToolResult> {
      // Default implementation delegates to existing executor
      throw new Error('executeTool not implemented - requires middleware')
    },

    *validateToolParams(_tool: AnyIsomorphicTool, _params: unknown): Operation<void> {
      // Default: no validation
    },

    *handleToolError(_tool: AnyIsomorphicTool, error: Error, _params: unknown): Operation<IsomorphicToolResult> {
      // Default: rethrow error
      throw error
    },

    *logToolExecution(_tool: AnyIsomorphicTool, _params: unknown, _result: IsomorphicToolResult): Operation<void> {
      // Default: no logging
    }
  }
)

// Export the operations for easy use
export const {
  executeTool,
  validateToolParams,
  handleToolError,
  logToolExecution
} = toolRuntimeApi.operations

// Export the API for middleware wrapping
export const toolRuntime = toolRuntimeApi

// Example middleware: tool logging and error handling
export function* withToolLoggingAndErrors() {
  yield* toolRuntime.around({
    executeTool: function* ([tool, params], next) {
      console.log(`🚀 Executing tool: ${tool.name}`)

      try {
        const result = yield* next(tool, params)
        console.log(`✅ Tool ${tool.name} completed`)
        return result
      } catch (error) {
        console.error(`❌ Tool ${tool.name} failed:`, error)
        return yield* handleToolError(tool, error as Error, params)
      }
    },

    handleToolError: function* ([tool, error], next) {
      // Provide structured error responses
      if (error.message.includes('timeout')) {
        return {
          callId: 'unknown',
          toolName: tool.name,
          ok: false,
          error: `Tool ${tool.name} timed out`
        }
      }

      if (error.message.includes('denied')) {
        return {
          callId: 'unknown',
          toolName: tool.name,
          ok: false,
          error: `Tool ${tool.name} was denied by user`
        }
      }

      return yield* next(tool, error, {})
    },

    logToolExecution: function* ([tool, params, result], next) {
      const logEntry = {
        tool: tool.name,
        timestamp: new Date().toISOString(),
        success: result.ok,
        error: result.error
      }

      console.log('📊 Tool execution:', logEntry)
      yield* next(tool, params, result)
    }
  })
}