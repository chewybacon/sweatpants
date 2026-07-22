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

/** Connect a causal scenario to the standard A2A HTTP+JSON product boundary. */
export function* connectStandardAgent(
  scenario: ScenarioContext,
  interfacePath = "/a2a",
): Operation<StandardAgentScenarioHandle> {
  const discovery = yield* call(() =>
    scenario.transport.fetch("http://test.invalid/.well-known/agent-card.json"),
  );
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
          scenario.transport.fetch(`http://test.invalid${interfacePath}/message:send`, {
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
