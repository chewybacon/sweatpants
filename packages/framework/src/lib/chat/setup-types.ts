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
