import { call, spawn, type Operation, type Task } from "effection";
import {
  parseForeignA2ASendResult,
  type ForeignA2AMessage,
  type ForeignA2ASendResult,
} from "@sweatpants/a2a";
import type { ScenarioContext } from "@sweatpants/test-rig";

export interface A2ATurnHandle {
  complete(): Operation<ForeignA2ASendResult>;
}

export interface StandardAgentScenarioHandle {
  readonly card: Record<string, unknown>;
  send(message: ForeignA2AMessage): Operation<A2ATurnHandle>;
}

interface StandardAgentConnectionOptions {
  /** Agent origin. Omit to use the test application's in-process transport. */
  origin?: string;
  interfacePath?: string;
  /** Fetch implementation for a genuinely remote origin. */
  fetch?: typeof globalThis.fetch;
}

/** Connect a causal scenario to a standard A2A HTTP+JSON boundary. */
export function* connectStandardAgent(
  scenario: ScenarioContext,
  options: StandardAgentConnectionOptions | string = {},
): Operation<StandardAgentScenarioHandle> {
  const normalized = typeof options === "string" ? { interfacePath: options } : options;
  const origin = normalized.origin ?? "http://test.invalid";
  const interfacePath = normalized.interfacePath ?? "/a2a";
  const fetcher =
    normalized.fetch ?? (normalized.origin ? globalThis.fetch : scenario.transport.fetch);
  const discovery = yield* call(() => fetcher(`${origin}/.well-known/agent-card.json`));
  if (!discovery.ok) {
    throw new Error(`A2A discovery failed with ${discovery.status}`);
  }
  const card = (yield* call(() => discovery.json())) as Record<string, unknown>;
  return {
    card,
    *send(message) {
      // The HTTP request remains live while the remote agent is parked on its
      // model effect. Return a turn immediately so the scenario can control
      // that model request before awaiting the terminal A2A response.
      const request: Task<ForeignA2ASendResult> = yield* spawn(function* () {
        const response = yield* call(() =>
          fetcher(`${origin}${interfacePath}/message:send`, {
            method: "POST",
            headers: { "content-type": "application/a2a+json" },
            body: JSON.stringify({ message }),
          }),
        );
        if (!response.ok) {
          const detail = yield* call(() => response.text());
          throw new Error(`A2A send failed with ${response.status}: ${detail}`);
        }
        return parseForeignA2ASendResult(yield* call(() => response.json()));
      });
      return {
        *complete() {
          return yield* request;
        },
      };
    },
  };
}

/**
 * Harness-facing remote-agent posture: real HTTP discovery and message send,
 * while model consequences remain causally controllable through the scenario.
 */
export function* connectRemoteStandardAgent(
  scenario: ScenarioContext,
  origin: string,
  interfacePath = "/a2a",
): Operation<StandardAgentScenarioHandle> {
  return yield* connectStandardAgent(scenario, {
    origin,
    interfacePath,
    fetch: globalThis.fetch,
  });
}
