export type ApprovalType = 'none' | 'confirm' | 'permission'
export type DenialBehavior = 'error' | 'disable' | 'abort'

export interface ApprovalSignalValue {
  callId: string
  approved: boolean
  reason?: string
}

export type { BaseToolContext, BrowserToolContext } from './browser-context.ts'
export type { ApprovalResult, PermissionType } from './browser-context.ts'

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
