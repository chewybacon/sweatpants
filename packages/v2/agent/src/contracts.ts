import type { z } from "zod";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type {
  ChatProgram,
  ChatProgramBinding,
  RecordedChatExecution,
} from "@sweatpan.ts/chat-host";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operation } from "@standard-durability/core";
import type { EffectCapabilities } from "@sweatpan.ts/hosting";
import type { ToolDefinition } from "@sweatpan.ts/tools";

type Effects = Record<string, EffectDefinition>;
export type BoundTool = ToolDefinition<z.ZodType, Effects, Effects, unknown>;

// Each body takes its own normalized input and grants. The inventory stores it
// without exposing an operation that could invoke it with another tool's grants.
export type AgentTool = Omit<BoundTool, "body"> & {
  readonly body: (...args: never[]) => ReturnType<BoundTool["body"]>;
};

export type AgentRun<R, Y> = Omit<
  ChatProgramBinding<R, Y>,
  "tools" | "descendantInteractionContracts" | "recovery" | "matches"
> & {
  /** Called in each child host scope, never during model inventory construction. */
  readonly installEffects?: (effects: EffectCapabilities<Y>) => Operation<void, Y>;
};

export interface AgentDefinition {
  bind<R, Y>(
    runtime: Runtime<Y>,
    program: ChatProgram<R>,
    run: AgentRun<R, Y>,
  ): RecordedChatExecution<R, Y>;
}
