import type { ElicitResponseInput } from './event-types.ts'

export const ECHO_TOOL_NAME = 'echo'

export interface EchoToolArgs extends Record<string, unknown> {
  message: string
}

export interface EchoElicitRequest {
  callId: string
  elicitId: string
  message: string
}

export function createEchoElicitRequest(callId: string, args: EchoToolArgs): EchoElicitRequest {
  return {
    callId,
    elicitId: `elicit:${callId}`,
    message: `Echo this message back? \"${args.message}\" (reply yes to confirm)`,
  }
}

export function completeEchoTool(args: EchoToolArgs, response: ElicitResponseInput): string {
  const normalized = response.response.trim().toLowerCase()
  if (normalized !== 'yes') {
    return `Echo cancelled by user response: ${response.response}`
  }
  return args.message
}

export function parseEchoArgs(raw: Record<string, unknown>): EchoToolArgs {
  const messageValue = raw['message']
  const message = typeof messageValue === 'string' ? messageValue : ''
  return { message }
}

export const echoToolSchema = {
  name: ECHO_TOOL_NAME,
  description: 'Echo a short message back, after asking the user for confirmation.',
  isIsomorphic: true as const,
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The exact message to echo back after confirmation.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  } as const,
}
