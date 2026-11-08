import type { JournalReader, OwnedJournal } from "@sweatpan.ts/durable";
import {
  createJournalPresentation,
  createJournalTreeStream,
  type JournalTreeObservation,
} from "@sweatpan.ts/hosting";
import type { Stream } from "@sweatpan.ts/runtime";
import type { Runtime } from "@sweatpan.ts/runtime";

// Public consumer checked against both source and emitted declarations.
export function* readerInference<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<string, { kind: string }, number, string, unknown, Y>,
) {
  const reader: JournalReader<string, { kind: string }, number, string, unknown, Y> = journal;
  const snapshot = yield* reader.read();
  if (snapshot.status === "completed") {
    const result: string = snapshot.value;
    void result;
  }
  const tree: Stream<JournalTreeObservation, void, Y> = createJournalTreeStream(
    runtime.composition,
    reader,
  );
  const subscription = yield* tree;
  const observation = yield* subscription.next();
  if (!observation.done && observation.value.state.status === "completed") {
    // @ts-expect-error Tree nodes are heterogeneous, including the root observation.
    const value: string = observation.value.state.value;
    void value;
  }
  const child = yield* reader.openChild("persisted-child-id");
  yield* createJournalPresentation(runtime.composition, "child-reader", child).operations.read();
  const state = yield* child.read();
  if (state.status === "completed") {
    // @ts-expect-error Child program payloads require application decoding.
    const result: string = state.value;
    void result;
  }
  // @ts-expect-error Navigation grants observation, not acceptance authority.
  child.accept("request", { ok: true, value: 1 });
  // @ts-expect-error A reader cannot acquire children or install result bindings.
  child.ensureChildren("request", {});
  // @ts-expect-error Read-only traversal cannot open descendant answer authority.
  reader.openDescendantInteractions("leaf");
  // @ts-expect-error Read-only navigation cannot open writable ingress.
  child.openChildInteractions("child", "program");
  // @ts-expect-error Participant answers use a separately authorized command assembly.
  child.interactions.answer({}, { ok: true, value: 1 });
}

export function* childIngressInference<Y>(
  owner: OwnedJournal<string, string, string, string, unknown, Y>,
) {
  const child = yield* owner.openChildInteractions<{ prompt: string }, number, { code: string }>(
    "child",
    "program",
  );
  const request: { prompt: string } = yield* child.journal.interactions.request({
    requestId: "request",
    resolutionId: "resolution",
  });
  // @ts-expect-error Answer ingress cannot drive child completion.
  child.journal.complete(0, "done");
  // @ts-expect-error Answer ingress cannot create new participant grants.
  child.journal.interactions.register("request");
  // @ts-expect-error Answer ingress cannot invalidate a registered grant.
  child.journal.interactions.invalidate({}, "reason");
  return request;
}

export function* descendantIngressInference<Y>(
  owner: OwnedJournal<string, string, string, string, unknown, Y>,
) {
  const leaf = yield* owner.openDescendantInteractions("nested-execution");
  const request = yield* leaf.journal.interactions.request({
    requestId: "request",
    resolutionId: "resolution",
  });
  // @ts-expect-error Ancestry checks do not decode heterogeneous program payloads.
  const typed: string = request;
  // @ts-expect-error Narrow ingress cannot navigate or acquire execution bindings.
  leaf.journal.ensureChild("request", {});
  return typed;
}
