import type { Stream } from "@sweatpan.ts/runtime";

/** Scoped model request boundary. Request and wire representation belong to the adapter contract. */
export interface ModelProvider<Request, Event, Response, Y> {
  /**
   * Subscribe to one fresh inference request. Subscription starts work and its scope
   * owns cancellation and cleanup. Events are provisional; completion returns the
   * authoritative provider response, not journal acceptance. Failure throws rather
   * than manufacturing a completed response. No retry or persistence is implied.
   * Each subscription is a distinct request, not a broadcast of one inference.
   */
  stream(request: Request): Stream<Event, Response, Y>;
}
