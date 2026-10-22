// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, createSignal, spawn } from "effection";
import { expect, it } from "vitest";
import { inProcess } from "@sweatpants/agent-host/server";
import { makePlugin } from "@sweatpants/react-chat";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import {
  durableSelection,
  selectionEffects,
  loadOptions,
} from "../../fixtures/durable-selection.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

it("reopens SQLite in a fresh host and replays a parked durable child exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-replacement-"));
  let generations = 0;
  let application: ReturnType<typeof createApplication>;
  const effects: string[] = [];
  try {
    await withTestScenario(
      {
        binding: "http",
        createApplication(context) {
          generations += 1;
          application = createApplication(context, {
            tools: [durableSelection],
            execution: inProcess(),
            effects: selectionEffects((topic) => effects.push(topic)),
            storage: { kind: "sqlite", path: join(directory, "authority.sqlite") },
          });
          return application;
        },
      },
      function* (rig) {
        // Arrange: an authored plugin awaits a test-owned external answer.
        const answer = createSignal<{ action: "accept"; content: { selected: string } }>();
        const plugin = makePlugin(durableSelection)
          .onElicit({
            choose: function* () {
              const subscription = yield* answer;
              return (yield* subscription.next()).value;
            },
          })
          .build();
        const first = yield* useClient(rig, { plugins: [plugin], threadId: "replacement" });

        // Act: accept an effect and sample, then persist an elicitation.
        const sending = yield* spawn(() =>
          call(() => first.sendMessage("Select after replacement")),
        );
        const outer = yield* rig.model.request();
        yield* outer.respond.toolCalls([
          { id: "replacement", name: "select_option", arguments: { topic: "replacement" } },
        ]);
        const nested = yield* rig.model.request();
        yield* nested.respond.text("Accepted before replacement");
        yield* waitForSnapshot(first, (state) => state.authority?.state === "parked");
        yield* sending;

        // Act: gracefully close the host and reopen the database in a new application.
        yield* call(() => first.close());
        yield* rig.host.replace();
        expect(generations).toBe(2);
        const resumed = yield* useClient(rig, { plugins: [plugin], threadId: "replacement" });
        yield* waitForSnapshot(resumed, (state) => state.authority?.state === "parked");
        expect(rig.model.requests()).toHaveLength(2);
        answer.send({ action: "accept", content: { selected: "replacement-alpha" } });
        const final = yield* rig.model.request();
        expect(JSON.stringify(final.body.input)).not.toContain("PRIVATE_SELECTION_NOTE");
        expect(JSON.stringify(final.body.input)).toContain("replacement-recorded");
        yield* final.respond.text("Replaced host completed");
        const ready = yield* waitForSnapshot(
          resumed,
          (state) => state.status === "ready" && state.authority?.state === "idle",
        );
        expect(JSON.stringify(ready.messages)).toContain("Replaced host completed");

        // Assert: inspect accepted journal facts as well as actual effect execution.
        expect(effects).toEqual(["replacement"]);
        expect(rig.model.requests()).toHaveLength(3);
        const storage = yield* call(() => application.inspect());
        const journal = yield* storage.programDriverJournalStore.withJournal(
          "replacement",
          (opened) => opened.readJournal("replacement"),
        );
        expect(
          journal.some(
            (entry) =>
              entry.payload.type === "TaskOpened" &&
              entry.payload.programId === durableSelection.manifest.programId,
          ),
        ).toBe(true);
        expect(
          journal.filter(
            (entry) =>
              entry.payload.type === "PullRequested" &&
              entry.payload.descriptor.kind === "effect" &&
              entry.payload.descriptor.name === loadOptions.name,
          ),
        ).toHaveLength(1);
        expect(
          journal.filter(
            (entry) =>
              entry.payload.type === "PullRequested" &&
              entry.payload.descriptor.kind === "record" &&
              entry.payload.descriptor.key === "selection-record",
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(journal)).not.toContain("function* ()");
        expect(JSON.stringify(journal)).not.toContain("ephemeral.tool.start");
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
