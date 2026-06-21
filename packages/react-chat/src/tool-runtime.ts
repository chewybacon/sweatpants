import type { Operation } from 'effection'

/**
 * Approval configuration for tools.
 *
 * - 'none': Execute immediately without approval
 * - 'confirm': Show confirmation dialog before execution
 * - 'permission': Requires browser permission grant
 */
export type ApprovalType = 'none' | 'confirm' | 'permission'

/**
 * Result of an approval request.
 */
export type ApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string }

/**
 * Browser permission types that can be requested.
 */
export type PermissionType =
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | (string & {})

/**
 * What happens when user denies a tool.
 */
export type DenialBehavior = 'error' | 'disable' | 'abort'

/**
 * Signal sent from React UI to approve/deny a tool.
 */
export interface ApprovalSignalValue {
  callId: string
  approved: boolean
  reason?: string
}

/**
 * Context passed to client-side tool execution.
 */
export interface ClientToolContext {
  requestApproval(message: string): Operation<ApprovalResult>
  requestPermission(type: PermissionType): Operation<ApprovalResult>
  reportProgress(message: string): Operation<void>
  signal: AbortSignal
  callId: string

  /**
   * Suspend the client generator and wait for UI input.
   *
   * This enables framework-agnostic client tools - the same tool works with
   * React, terminal, or any other UI. The platform layer registers handlers
   * for different request types and responds when the user provides input.
   *
   * @param type - Type tag for routing to handlers (e.g., 'select-choice', 'yes-no')
   * @param payload - Data the UI needs to render
   * @returns The response from the UI handler
   *
   * @example
   * ```typescript
   * const response = yield* ctx.waitFor('select-choice', {
   *   choices: ['A', 'B', 'C'],
   *   prompt: 'Pick a card',
   * })
   * // response is { selectedChoice: 'B' } or whatever the handler returns
   * ```
   *
   * @remarks
   * This is optional - not all tool executions will have waitFor available.
   * Tools should check if `ctx.waitFor` exists before using it, or the
   * tool registry can guarantee it's always available for tools that need it.
   */
  waitFor?<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

export class ToolDeniedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason?: string
  ) {
    super(reason ?? `Tool "${toolName}" was denied by user`)
    this.name = 'ToolDeniedError'
  }
}

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number
  ) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`)
    this.name = 'ToolTimeoutError'
  }
}
