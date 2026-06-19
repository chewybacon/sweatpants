import type { Operation, Stream } from 'effection'

export interface Runtime {
  stream(model: Model, context: Context, options?: StreamOptions): Stream<StreamEvent, AssistantMessage>
  generateImages(model: ImageModel, context: ImageGenerationContext, options?: ImageGenerationOptions): Operation<AssistantImages>
}

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl?: string
  headers?: Record<string, string>
  reasoning: boolean
  input: InputModality[]
  contextWindow: number
  maxTokens: number
  cost?: Cost
  compat?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ImageModel {
  id: string
  name: string
  api: string
  provider: string
  baseUrl?: string
  headers?: Record<string, string>
  input: InputModality[]
  output: OutputModality[]
  cost?: Cost
  compat?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type InputModality = 'text' | 'image' | 'audio'
export type OutputModality = 'text' | 'image'

export interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type Message = UserMessage | SystemMessage | AssistantMessage | ToolResultMessage

export interface UserMessage {
  role: 'user'
  content: string | ContentBlock[]
  timestamp?: number
}

export interface SystemMessage {
  role: 'system'
  content: string
  timestamp?: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
  usage?: Usage
  stopReason?: StopReason
  responseId?: string
  errorMessage?: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: ContentBlock[]
  isError: boolean
  timestamp?: number
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock

export interface TextBlock {
  type: 'text'
  text: string
  /** Opaque provider replay signature, preserved but never interpreted by Sweatpants. */
  textSignature?: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  format?: string
  /** Opaque provider replay signature, preserved but never interpreted by Sweatpants. */
  thinkingSignature?: string
  /** Whether the provider marked this reasoning block as redacted. */
  redacted?: boolean
}

export interface ToolCallBlock {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Opaque provider replay signature associated with this tool call. */
  thoughtSignature?: string
}

export interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

export type StreamEvent =
  | { type: 'start'; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallBlock; partial: AssistantMessage; metadata?: EventMetadata }
  | { type: 'done'; reason: StopReason; message: AssistantMessage; metadata?: EventMetadata }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage; metadata?: EventMetadata }

export interface ImageGenerationContext {
  input: Array<TextBlock | ImageBlock>
}

export interface AssistantImages {
  output: Array<TextBlock | ImageBlock>
  usage?: Usage
  stopReason?: StopReason
  responseId?: string
  errorMessage?: string
  metadata?: Record<string, unknown>
}

export interface StreamOptions {
  signal?: AbortSignal
  apiKey?: string | null
  env?: Record<string, string | undefined>
  sessionId?: string
  toolChoice?: 'auto' | 'none' | 'required'
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  responseFormat?: { type: 'json_schema'; name?: string; schema: Record<string, unknown> }
  providerOptions?: Record<string, unknown>
  onPayload?: (payload: unknown) => void
}

export interface ImageGenerationOptions {
  signal?: AbortSignal
  apiKey?: string | null
  env?: Record<string, string | undefined>
  headers?: Record<string, string>
  providerOptions?: Record<string, unknown>
  onPayload?: (payload: unknown) => void
  onResponse?: (response: unknown) => void
}

export interface Usage {
  input: number
  output: number
  total?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: Partial<Cost> & { total?: number }
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | string

export interface Cost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface EventMetadata {
  provider?: string
  model?: string
  api?: string
  rawType?: string
  raw?: unknown
  [key: string]: unknown
}
