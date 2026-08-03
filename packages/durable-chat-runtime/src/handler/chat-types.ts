import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import type { Message as ChatMessage, ChatSessionStreamEvent } from "@sweatpants/chat-core";
import type { StreamOptions } from "@sweatpants/model-provider";
import type { ToolExecutionRef } from "@sweatpants/tool-runtime";
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
  completion: ElicitExchangeCompletion<unknown>;
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
  trigger?: "submit-message" | "regenerate-message" | "cancel-run";
  clientId?: string;
  messageId?: string;
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
  model?: ModelSelection;
  elicitResponses?: ElicitResponse[];
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
