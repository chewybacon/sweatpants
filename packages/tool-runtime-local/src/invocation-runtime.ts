import type { Operation } from "effection";
import {
  ToolInvocationHostPort,
  type ToolInvocationEventSource,
  type ToolSessionStore,
} from "@sweatpants/tool-session";
import { createToolInvocationHost } from "./invocation-host.ts";
import { createToolSessionRegistry, type ToolSessionRegistryOptions } from "./session-registry.ts";

export interface LocalToolInvocationRuntime {
  readonly events: ToolInvocationEventSource;
}

/**
 * Installs one local invocation host and returns its pull-only event source.
 * Private registry and resource ownership do not escape this composition seam.
 */
export function* createLocalToolInvocationRuntime(
  store: ToolSessionStore,
  options: ToolSessionRegistryOptions,
): Operation<LocalToolInvocationRuntime> {
  const registry = yield* createToolSessionRegistry(store, options);
  yield* ToolInvocationHostPort.installDriver(createToolInvocationHost(registry));
  return {
    events: {
      *open(invocationId) {
        const session = yield* registry.get(invocationId);
        return session?.projection ?? null;
      },
    },
  };
}
