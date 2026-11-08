import type { JournalSnapshot, InteractionRegistration } from "@sweatpan.ts/durable";
import type { JournalPresentationState } from "./contracts.ts";

/** Project only presentation facts from one detached journal snapshot. */
export function projectJournalState<R, Q, S>(
  snapshot: JournalSnapshot<R, Q, S> & { readonly interaction?: InteractionRegistration },
): JournalPresentationState<R, Q> {
  return snapshot.status === "completed"
    ? { status: "completed", revision: snapshot.revision, value: snapshot.value }
    : snapshot.status === "cancelled"
      ? {
          status: "cancelled",
          revision: snapshot.revision,
          reason: snapshot.reason,
          failure: snapshot.failure,
        }
      : {
          status: "running",
          revision: snapshot.revision,
          cancellation: snapshot.cancellation,
          cancellationRequested: snapshot.cancellationRequested,
          pending: snapshot.pending,
          children: snapshot.children,
          interaction: snapshot.interaction,
        };
}
