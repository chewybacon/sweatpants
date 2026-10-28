import type { Outcome } from "@standard-durability/core";
import type {
  AttemptGrant,
  ChildLink,
  InteractionRegistration,
  JournalSnapshot,
} from "@sweatpan.ts/durable";

/** Data only: one member of a colocated owned execution tree. */
export interface MemoryRecord<R = unknown, Q = unknown, V = unknown, E = unknown, S = unknown> {
  snapshot: JournalSnapshot<R, Q, V, E, S>;
  grants: Map<string, AttemptGrant>;
  invalidated: Map<string, string>;
  registrations: Map<string, InteractionRegistration>;
  queuedStop?: string;
  children: Map<string, ChildLink>;
  parent?: ChildLink;
}

/** Trusted assembly binding, deliberately excluded from cloned records. */
export interface ChildBinding {
  readonly program: string;
  readonly outcome: (value: unknown) => Outcome<unknown, unknown>;
}
