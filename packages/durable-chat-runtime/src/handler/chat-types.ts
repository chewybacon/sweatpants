import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import type { ChatHistoryEntry, ConversationCommand } from "@sweatpants/chat-core";
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
  callId?: string;
  toolName?: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  completion: ElicitExchangeCompletion<unknown>;
}

export interface PluginAbortRequest {
  sessionId?: string;
  reason?: string;
  commandId?: string;
}

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ChatRequestBody {
  /** Present on mutating chat commands; absent on hydration/reconnect. */
  command?: ConversationCommand;
  knownWindowToken?: string;
  clientId?: string;
  messageId?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  parentRunId?: string;
  state?: unknown;
  /** Client/plugin contract metadata; never an executable inventory declaration. */
  tools?: unknown[];
  context?: Array<{ description: string; value: string }>;
  forwardedProps?: unknown;
  resume?: ResumeEntry[];
  messages: readonly ChatHistoryEntry[];
  systemPrompt?: string;
  persona?: string;
  personaConfig?: unknown;
  enableOptionalTools?: string[];
  effort?: string;
  streamOptions?: StreamOptions;
  initialToolChoice?: StreamOptions["toolChoice"];
  model?: ModelSelection;
  elicitResponses?: ElicitResponse[];
  pluginAbort?: PluginAbortRequest;
}
