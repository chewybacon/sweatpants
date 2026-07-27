import { definePort } from "@sweatpants/foundation/port";
import type { Operation } from "effection";
import type {
  ToolSessionEntry,
  ToolSessionStatus,
  ToolSessionStore,
} from "@sweatpants/framework/chat/mcp-tools";

export class ToolSessionStoreUnavailable extends Error {
  readonly code = "tool_session_store_unavailable";
  constructor() {
    super("No tool session store driver is installed");
    this.name = "ToolSessionStoreUnavailable";
  }
}

function unavailable(): never {
  throw new ToolSessionStoreUnavailable();
}

/**
 * Tool session persistence as a port.
 *
 * The registry resolves storage through this seam so observation, fault
 * injection, and remote storage compose as scoped middleware instead of
 * widening the store type with debug-only methods.
 */
export const ToolSessionStorePort = definePort<ToolSessionStore>("tool-session-store", {
  *get(_sessionId: string): Operation<ToolSessionEntry | null> {
    return unavailable();
  },
  *set(_sessionId: string, _entry: ToolSessionEntry): Operation<void> {
    return unavailable();
  },
  *delete(_sessionId: string): Operation<void> {
    return unavailable();
  },
  *updateRefCount(_sessionId: string, _delta: number): Operation<number> {
    return unavailable();
  },
  *updateStatus(_sessionId: string, _status: ToolSessionStatus): Operation<void> {
    return unavailable();
  },
});

export const ToolSessionStoreApi = ToolSessionStorePort.api;

/** Installs one tool session store adapter for the calling scope. */
export function installToolSessionStore(store: ToolSessionStore): Operation<void> {
  return ToolSessionStorePort.installDriver(store);
}
