/**
 * Tool Runtime Types
 *
 * This module provides approval/permission types and error classes
 * for tool execution. Context types are defined in contexts.ts.
 */
import type { BrowserToolContext } from '../contexts'

/**
 * Approval configuration for tools.
 *
 * - 'none': Execute immediately without approval
 * - 'confirm': Show confirmation dialog before execution
 * - 'permission': Requires browser permission grant
 */
export type ApprovalType = 'none' | 'confirm' | 'permission'

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
 * @deprecated Use BaseToolContext or BrowserToolContext from contexts.ts instead.
 * 
 * This type alias exists for backwards compatibility with existing code
 * that imports ClientToolContext. It maps to BrowserToolContext since
 * that's the most common use case (browser-side execution with waitFor).
 */
export type ClientToolContext = BrowserToolContext

// Re-export context types for convenience
export type { BaseToolContext, BrowserToolContext, AgentToolContext } from '../contexts'
export type { ApprovalResult, PermissionType } from '../contexts'

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
