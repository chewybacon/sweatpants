/**
 * MCP Tools Module
 *
 * Generator-based primitives for authoring MCP (Model Context Protocol) tools.
 *
 * @example Simple tool
 * ```typescript
 * import { createMCPTool } from '@grove/framework/mcp-tools'
 * import { z } from 'zod'
 *
 * const calculator = createMCPTool('calculate')
 *   .description('Perform a calculation')
 *   .parameters(z.object({ expression: z.string() }))
 *   .execute(function*(params) {
 *     return { result: evaluate(params.expression) }
 *   })
 * ```
 *
 * @example Multi-turn tool with handoff
 * ```typescript
 * const bookFlight = createMCPTool('book_flight')
 *   .description('Book a flight with user confirmation')
 *   .parameters(z.object({ destination: z.string() }))
 *   .requires({ elicitation: true })
 *   .handoff({
 *     *before(params) {
 *       return { flights: searchFlights(params.destination) }
 *     },
 *     *client(handoff, ctx) {
 *       const result = yield* ctx.elicit({
 *         message: 'Pick a flight:',
 *         schema: z.object({ flightId: z.string() })
 *       })
 *       return result.action === 'accept' ? result.content : null
 *     },
 *     *after(handoff, client) {
 *       return client ? `Booked ${client.flightId}` : 'Cancelled'
 *     },
 *   })
 * ```
 *
 * @packageDocumentation
 */

// Builder
export { createMCPTool } from './builder'
export type {
  MCPToolBuilderBase,
  MCPToolBuilderWithDescription,
  MCPToolBuilderWithParams,
  FinalizedMCPTool,
  MCPToolTypes,
  InferMCPResult,
  InferMCPParams,
  InferMCPHandoff,
  InferMCPClient,
} from './builder'

// Types
export type {
  MCPClientContext,
  MCPServerContext,
  MCPHandoffConfig,
  MCPToolDef,
  AnyMCPTool,
  ElicitResult,
  ElicitConfig,
  SampleConfig,
  ModelPreferences,
  LogLevel,
  InferMCPToolParams,
  InferMCPToolResult,
  InferMCPToolHandoff,
  InferMCPToolClient,
} from './types'

// Errors
export {
  MCPCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
  MCPTimeoutError,
  MCPDisconnectError,
} from './types'

// Mock runtime (for testing)
export {
  createMockMCPClient,
  runMCPTool,
  runMCPToolOrThrow,
} from './mock-runtime'
export type {
  MockMCPClient,
  MockMCPClientConfig,
  RunMCPToolOptions,
} from './mock-runtime'
