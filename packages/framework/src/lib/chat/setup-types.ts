import type { Operation } from 'effection'
import type { ZodType } from 'zod'

/**
 * A finalized isomorphic tool definition accepted by server-side chat setup.
 */
export interface IsomorphicTool {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: ZodType<any>
  approval?: {
    client?: 'none' | 'confirm' | 'permission'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientMessage?: string | ((params: any) => string)
  }
  handoffConfig?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    before: (params: any, ctx: any) => Operation<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: (handoff: any, ctx: any, params: any) => Operation<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    after: (handoff: any, client: any, ctx: any, params: any) => Operation<any>
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server?: (params: any, ctx: any, clientOutput?: any) => Operation<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: (input: any, ctx: any, params: any) => Operation<any>
}

export interface ResolvedPersona {
  name: string
  systemPrompt: string
  tools: string[]
  model?: Record<string, string>
  capabilities: {
    thinking: boolean
    streaming: boolean
    tools: string[]
  }
}

export type PersonaResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  name: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any,
  enableOptionalTools?: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effort?: any,
) => ResolvedPersona
