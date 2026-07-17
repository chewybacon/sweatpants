import type { Operation } from "effection";
import { ForeignA2ADurableSession } from "./foreign-session.ts";
import type { ForeignA2AClientPort } from "./foreign-client.ts";
import type { ForeignA2AStartRequest } from "./foreign-task-types.ts";

export type ForeignA2AConformanceScenario =
  | "direct_message"
  | "long_running_task"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "initial_response_loss";

export interface ForeignA2AConformanceFactory {
  create(scenario: ForeignA2AConformanceScenario): Operation<{
    client: ForeignA2AClientPort;
    request: ForeignA2AStartRequest;
  }>;
}
export interface ForeignA2AConformanceEvidence {
  readonly scenario: ForeignA2AConformanceScenario;
  readonly observed: string;
}

/** Provider-neutral semantic harness for foreign A2A clients and servers. */
export function* runForeignA2AConformance(
  factory: ForeignA2AConformanceFactory,
): Operation<ForeignA2AConformanceEvidence[]> {
  const evidence: ForeignA2AConformanceEvidence[] = [];
  for (const scenario of [
    "direct_message",
    "long_running_task",
    "input_required",
    "auth_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
    "initial_response_loss",
  ] as const) {
    const fixture = yield* factory.create(scenario);
    const session = new ForeignA2ADurableSession({
      client: fixture.client,
      polling: { initialMs: 1, maxMs: 2, multiplier: 1, jitter: 0, maxPolls: 10 },
      random: () => 0.5,
    });
    const transition = yield* session.start(fixture.request);
    const observed =
      transition.event.type === "terminal"
        ? transition.event.result.status
        : transition.event.type === "interruption"
          ? transition.event.interruption.type
          : transition.event.type === "indeterminate"
            ? "indeterminate"
            : "working";
    evidence.push({ scenario, observed });
  }
  return evidence;
}
