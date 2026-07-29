import type { Operation } from "effection";
import type {
  ConversationReplayState,
  Message as ChatMessage,
  ChatSessionStreamEvent,
  StreamOptions,
  ToolExecutionTrace,
} from "@sweatpants/chat-core";
import type { ToolExecutionRef } from "@sweatpants/tool-session/chat-runtime";
import type { ResumeEntry } from "./types.ts";

export interface ChatHandlerSetupContext {
  request: Request;
  body: ChatRequestBody;
}

export type ChatHandlerSetup = (ctx: ChatHandlerSetupContext) => Operation<void>;

export interface ElicitResponse {
  sessionId: string;
  callId: string;
  toolName?: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  result: {
    action: "accept" | "decline" | "cancel";
    content?: unknown;
  };
  trace?: ToolExecutionTrace;
}

export interface PluginAbortRequest {
  sessionId?: string;
  reason?: string;
}

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ChatRequestBody {
  conversationId?: string;
  threadId?: string;
  runId?: string;
  parentRunId?: string;
  state?: unknown;
  tools?: unknown[];
  context?: Array<{ description: string; value: string }>;
  forwardedProps?: unknown;
  resume?: ResumeEntry[];
  messages: ChatMessage[];
  systemPrompt?: string;
  persona?: string;
  personaConfig?: unknown;
  enableOptionalTools?: string[];
  effort?: string;
  streamOptions?: StreamOptions;
  initialToolChoice?: StreamOptions["toolChoice"];
  enabledTools?: boolean | string[];
  enabledPlugins?: string[];
  model?: ModelSelection;
  elicitResponses?: ElicitResponse[];
  replayState?: ConversationReplayState;
  pluginAbort?: PluginAbortRequest;
}

export interface DurableStreamEvent {
  lsn: number;
  event: ChatSessionStreamEvent;
}

export interface DurableStreamParams {
  sessionId?: string;
  lastLSN?: number;
}
