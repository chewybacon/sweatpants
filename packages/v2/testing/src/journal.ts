import type { Runtime } from "@sweatpan.ts/runtime";
import type { Accepted, JournalBackend, JournalRecord, RequestRecord } from "@sweatpan.ts/durable";
import { createJournalRecord } from "@sweatpan.ts/durable";
import { createProtocolRig } from "./protocol.ts";

/** Scripted async storage peer. Models one serial transaction domain, not database crash safety. */
export function createJournalStorageRig<Y>(runtime: Runtime<Y>, program: string) {
  const id = "root";
  const peer = createProtocolRig();
  const pauses = new Set<string>();
  const events: string[] = [];
  let locked = false;
  let state = {
    records: new Map<string, JournalRecord>([[id, createJournalRecord(program)]]),
    requests: new Map<string, RequestRecord>(),
    history: new Map<string, Accepted<unknown, unknown, unknown>[]>(),
  };
  const key = (execution: string, request: string) => JSON.stringify([execution, request]);
  function* io(name: string) {
    events.push(name);
    if (pauses.delete(name)) {
      yield* runtime.fromPromise((signal) => peer.send({ id: name, token: name }, signal));
    } else {
      yield* runtime.fromPromise(async () => undefined);
    }
  }
  const backend: JournalBackend<Y> = {
    transact(work) {
      return runtime.using(
        function* () {
          if (locked) {
            throw new Error("Storage transaction occupied");
          }
          locked = true;
          return structuredClone(state);
        },
        function* (draft) {
          const result = yield* work({
            *get(execution) {
              yield* io("get");
              return structuredClone(draft.records.get(execution));
            },
            *set(execution, record) {
              draft.records.set(execution, structuredClone(record));
              yield* io("set");
            },
            *request(execution, request) {
              yield* io("request");
              return structuredClone(draft.requests.get(key(execution, request)));
            },
            *setRequest(execution, request, record) {
              draft.requests.set(key(execution, request), structuredClone(record));
              yield* io("setRequest");
            },
            *accepted(execution, receipt) {
              yield* io("accepted");
              return structuredClone(
                draft.history.get(execution)?.find((entry) => entry.receipt === receipt),
              );
            },
            *append(execution, entry) {
              const history = draft.history.get(execution) ?? [];
              if (
                entry.sequence !== history.length ||
                history.some((prior) => prior.receipt === entry.receipt)
              ) {
                throw new Error("Conflicting history");
              }
              history.push(structuredClone(entry));
              draft.history.set(execution, history);
              yield* io("append");
            },
          });
          const detached = structuredClone(result);
          yield* io("commit");
          state = draft;
          events.push("published");
          return detached;
        },
        function* () {
          try {
            yield* io("close");
          } finally {
            locked = false;
            events.push("released");
          }
        },
      );
    },
    *history(execution, from, end, limit) {
      yield* io("history");
      return structuredClone(
        (state.history.get(execution) ?? []).slice(from, Math.min(end, from + limit)),
      );
    },
  };
  return { id, backend, peer, events, pause: (name: string) => pauses.add(name) };
}
