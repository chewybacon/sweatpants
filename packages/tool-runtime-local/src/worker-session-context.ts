/**
 * Worker Session Context
 *
 * Provides context access to worker session state for API operations.
 */

import { createContext, type Operation, type Queue } from "effection";
import type { ElicitExchangeCompletion, SampleExchangeCompletion } from "@sweatpants/agent-sdk";
import type { ToolSessionEvent, ToolSessionStatus } from "@sweatpants/tool-session";

export interface WorkerSessionState {
  /** Pending elicit channels, keyed by elicitId */
  pendingElicitChannels: Map<string, Queue<ElicitExchangeCompletion<unknown>, void>>;

  /** Pending sample channels, keyed by sampleId */
  pendingSampleChannels: Map<string, Queue<SampleExchangeCompletion, void>>;

  /** Emit a session event (adds LSN/timestamp internally) */
  emitEvent(event: { type: ToolSessionEvent["type"] } & Record<string, unknown>): Operation<void>;

  /** Generate the next LSN */
  nextLsn(): number;

  /** Update session status */
  setStatus(status: ToolSessionStatus): void;
}

export const WorkerSessionStateContext = createContext<WorkerSessionState>("worker-session.state");
