import type { Runtime } from "@sweatpan.ts/runtime";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { ChatExecution, ChatProgram } from "@sweatpan.ts/chat-host";
import type { ChatHistoryMessage, ChatLoopResult, ChatSampling } from "@sweatpan.ts/chat";
import type { ToolInteractionContract } from "@sweatpan.ts/tools";

/** Application-local policy for the two demos, not a framework catalog API. */
export interface ChatDemo {
  readonly namespace: string;
  readonly viewEvent: string;
  readonly program: ChatProgram<ChatLoopResult>;
  readonly systemMessage: ChatHistoryMessage;
  readonly tools: readonly ToolInteractionContract[];
  bind<Y>(
    runtime: Runtime<Y>,
    journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
    sampling: ChatSampling<Y>,
  ): ChatExecution<ChatLoopResult, Y>;
  decodeInput(effect: string, input: unknown): unknown;
  validateAnswer(effect: string, input: unknown, value: unknown): void;
  formatResult(value: unknown): string;
}
