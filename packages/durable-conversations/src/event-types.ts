import type { Message } from '@sweatpants/framework/chat'

export type ConversationActor = 'user' | 'assistant' | 'tool'

export type ConversationEventType =
  | 'user_message'
  | 'assistant_message_delta'
  | 'assistant_message_complete'
  | 'tool_call'
  | 'tool_result'
  | 'elicit_request'
  | 'elicit_response'

export interface ConversationEvent {
  id: string
  from: ConversationActor
  type: ConversationEventType
  content: string
  timestamp: number
  messageId?: string
  callId?: string
  toolName?: string
  elicitId?: string
  arguments?: Record<string, unknown>
}

export interface ConversationMessageInput {
  role: Message['role']
  content: string
}

export interface ElicitResponseInput {
  callId: string
  elicitId: string
  response: string
}

export interface ConversationPostBody {
  messages?: ConversationMessageInput[]
  elicitResponses?: ElicitResponseInput[]
}
