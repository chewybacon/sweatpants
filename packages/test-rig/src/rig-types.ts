import type { AgUiProbe } from "./ag-ui.ts";
import type { ChatFetch, ChatHandle } from "./chat.ts";
import type { ModelHandle } from "./model.ts";
import type { StreamTransportHandle } from "./transport.ts";

/** Adapter-edge controls exposed only through causal ScenarioContext operations. */
export interface ScenarioLifecycleControls {
  gracefulShutdown(options: { graceMs: number }): Promise<void>;
  replace(): Promise<void>;
  armFault(point: string): Promise<void>;
  waitForFault(point: string): Promise<void>;
  readHistory(sessionId: string, cursor?: string): Promise<unknown>;
  checkpointEvidence(executionId: string): Promise<unknown | null>;
  storageMetrics(): Promise<unknown>;
}

/**
 * The rig surface a scenario drives.
 *
 * Declared here rather than in `index.ts` so scenario authoring can depend on
 * the shape without importing the package barrel, which would make the barrel
 * and its own modules mutually dependent.
 */
export interface TestRig {
  readonly model: ModelHandle;
  readonly agui: AgUiProbe;
  readonly chat: ChatHandle;
  readonly streams: StreamTransportHandle;
  readonly fetch: ChatFetch;
  readonly lifecycle: ScenarioLifecycleControls;
  readonly state: "active" | "poisoned" | "cancelling" | "closed";
  verifyAndClose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
