import type { Composition, Operation } from "@standard-durability/core";
import type { Accepted, ChildLink, JournalReader } from "@sweatpan.ts/durable";
import type { JournalPresentationState } from "./contracts.ts";
import { projectJournalState } from "./presentation-state.ts";
import { installHostingMiddleware } from "./scope.ts";

type Reader<Y> = JournalReader<unknown, unknown, unknown, unknown, unknown, Y>;
export type ExecutionPresentationFrame = {
  readonly execution: string;
  readonly replay: boolean;
} & (
  | { readonly kind: "accepted"; readonly entry: Accepted<unknown, unknown, unknown> }
  | {
      readonly kind: "children";
      readonly boundary: string;
      readonly request: unknown;
      readonly children: readonly ChildLink[];
    }
  | { readonly kind: "state"; readonly state: JournalPresentationState<unknown, unknown> }
  | {
      readonly kind: "delivery";
      readonly requestId: string;
      readonly request: unknown;
      readonly phase: "started" | "failed";
    }
);

/** One attempt's incremental presentation. Sink receives detached trusted data and
 * owns disclosure. No Guests or writers are opened by restore. Live installation
 * covers owned journals driven by createHosting in this native scope; external
 * writers require a fresh restore/reader. Reads are not an atomic tree snapshot. */
export function createExecutionPresentation<Y>(
  composition: Composition<Y>,
  emit: (frame: ExecutionPresentationFrame) => void,
) {
  const positions = new Map<string, number>();
  const revisions = new Map<string, number>();
  const linksSeen = new Set<string>();
  const send = (frame: ExecutionPresentationFrame) => emit(structuredClone(frame));
  function* read(reader: Reader<Y>, replay: boolean, descend?: Set<string>): Operation<void, Y> {
    if (descend?.has(reader.id)) {
      return;
    }
    descend?.add(reader.id);
    const snapshot = yield* reader.read();
    let position = positions.get(reader.id) ?? 0;
    function* children(boundary: string, request: unknown): Operation<void, Y> {
      const links = yield* reader.readChildren(boundary);
      if (links.length && !linksSeen.has(reader.id + ":" + boundary)) {
        linksSeen.add(reader.id + ":" + boundary);
        send({
          kind: "children",
          execution: reader.id,
          replay,
          boundary,
          request,
          children: links,
        });
      }
      if (descend) {
        for (const link of links) {
          const child = yield* reader.openChild(link.childId);
          yield* read(child, replay, descend);
        }
      }
    }
    while (position < snapshot.history.end.position) {
      const entries = yield* snapshot.history.read(position, 128);
      if (!entries.length) {
        break;
      }
      for (const entry of entries) {
        if (entry.sequence >= (positions.get(reader.id) ?? 0)) {
          positions.set(reader.id, entry.sequence + 1);
          send({ kind: "accepted", execution: reader.id, replay, entry });
        }
        yield* children(entry.receipt, entry.request);
        position = entry.sequence + 1;
      }
    }
    if (snapshot.status === "running" && snapshot.pending) {
      yield* children(snapshot.pending.id, snapshot.pending.request);
    }
    if ((revisions.get(reader.id) ?? -1) < snapshot.revision) {
      revisions.set(reader.id, snapshot.revision);
      send({ kind: "state", execution: reader.id, replay, state: projectJournalState(snapshot) });
    }
  }
  return {
    /** Restore retained accepted history, including completed children, once per attempt. */
    restore(root: Reader<Y>): Operation<void, Y> {
      return read(root, true, new Set());
    },
    *install(): Operation<void, Y> {
      yield* installHostingMiddleware(composition, {
        *install(host, journal) {
          // Plain Journal implementations need not support owned-tree observation.
          if (!("id" in journal) || !("readChildren" in journal) || !("openChild" in journal)) {
            return;
          }
          const reader = journal as Reader<Y>;
          yield* read(reader, false);
          yield* composition.ensure(() => read(reader, false));
          yield* host.around({
            *activate(args, next) {
              const value = yield* next(...args);
              yield* read(reader, false);
              return value;
            },
            *child(args, next) {
              const value = yield* next(...args);
              yield* read(reader, false);
              return value;
            },
            *handle([request], next) {
              const grant = yield* host.delivery.expect();
              send({
                kind: "delivery",
                execution: reader.id,
                replay: false,
                requestId: grant.requestId,
                request,
                phase: "started",
              });
              return yield* composition.catchError(
                () => next(request),
                function* (error) {
                  send({
                    kind: "delivery",
                    execution: reader.id,
                    replay: false,
                    requestId: grant.requestId,
                    request,
                    phase: "failed",
                  });
                  throw error;
                },
              );
            },
          });
          yield* host.attempts.around({
            *settle(args, next) {
              const accepted = yield* next(...args);
              yield* read(reader, false);
              return accepted;
            },
          });
        },
      });
    },
  };
}
