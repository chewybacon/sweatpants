import type { Operation, Subscription } from 'effection'

export interface ProtocolHandlerContext {
  request: Request
  headers: Headers
  status: number
}

export type ProtocolSetupResult =
  | Subscription<string, void>
  | {
    subscription: Subscription<string, void>
    cleanup?: () => Operation<void>
  }
