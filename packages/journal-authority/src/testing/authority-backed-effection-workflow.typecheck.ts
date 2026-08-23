import { useScope, type Effect, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";

import {
  ephemeral,
  record,
  type DurableProgramEffect,
  type Workflow,
} from "./authority-backed-effection-workflow.ts";

export function* validWorkflow(): Workflow<Json> {
  const prefix = "valid";
  const value = yield* ephemeral(
    (function* (): Operation<string> {
      yield* useScope();
      return `${prefix}-ephemeral`;
    })(),
  );
  const recorded = yield* record({ key: value }, function* () {
    return "recorded";
  });
  return recorded;
}

export const effectCompatibility: Effect<string> = {} as DurableProgramEffect<string>;

export function* rejectsPlainOperationYield(): Workflow<void> {
  // @ts-expect-error A Workflow may not delegate directly to a plain Operation.
  yield* (function* (): Operation<void> {
    yield* useScope();
  })();
}

function acceptsWorkflow(_workflow: Workflow<unknown>): void {}

export function checkPlainOperationChild(): void {
  acceptsWorkflow(
    // @ts-expect-error A plain Operation is not a Workflow child.
    (function* (): Operation<string> {
      return "ordinary";
    })(),
  );
}
