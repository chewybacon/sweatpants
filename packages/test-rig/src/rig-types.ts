import type { ChatFetch, ChatHandle } from "./chat.ts";
import type { ModelHandle } from "./model.ts";
import type { StreamTransportHandle } from "./transport.ts";

/**
 * The rig surface a scenario drives.
 *
 * Declared here rather than in `index.ts` so scenario authoring can depend on
 * the shape without importing the package barrel, which would make the barrel
 * and its own modules mutually dependent.
 */
export interface TestRig {
  readonly model: ModelHandle;
  readonly chat: ChatHandle;
  readonly streams: StreamTransportHandle;
  readonly fetch: ChatFetch;
  readonly state: "active" | "poisoned" | "cancelling" | "closed";
  verifyAndClose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
