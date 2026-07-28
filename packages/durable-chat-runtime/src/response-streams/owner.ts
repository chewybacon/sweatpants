import { createContext, type Operation, type Scope } from "effection";
import type { OwnedTaskHandle } from "./owned-task.ts";

/** Structural Host/Turn owner used to supervise response-stream writers. */
export interface DurableStreamsOwner {
  readonly scope: Scope;
  readonly register: (work: OwnedTaskHandle<void>) => void;
}

const DurableStreamsOwnerContext = createContext<DurableStreamsOwner | undefined>(
  "sweatpants-durable-streams-owner",
  undefined,
);

export function* installDurableStreamsOwner(owner: DurableStreamsOwner): Operation<void> {
  yield* DurableStreamsOwnerContext.set(owner);
}

export function useDurableStreamsOwner(): Operation<DurableStreamsOwner | undefined> {
  return DurableStreamsOwnerContext.get();
}
