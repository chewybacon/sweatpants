import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createInMemoryShellDrivers } from "../shell/in-memory-shell.ts";
import { createStoredShellDrivers } from "../shell/stored-shell.ts";
import { authorityStateFromSnapshot } from "../state/authority-state.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";

const options = {
  journalId: "head-identity",
  now: () => 1_000,
  keyring: createCapabilityKeyring("tests", [{ keyId: "key", secret: "x".repeat(32) }]),
};
const manifest = {
  programId: "head-identity",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" as const },
};

for (const backend of ["memory", "stored"] as const) {
  describe(`${backend} semantic head identity`, () => {
    it("survives cold restore and control updates, and fences a ticket after a semantic append", async () => {
      const store = createMemoryExecutionStore();
      let drivers =
        backend === "stored"
          ? createStoredShellDrivers(store, options)
          : createInMemoryShellDrivers(options);
      await run(function* () {
        const open = {
          sessionId: "one",
          turnId: "turn",
          taskId: "root",
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: "attachment",
          audience: "host",
        };
        const opened = yield* drivers.authority.command({
          type: "execution.open-task",
          request: open,
        });
        const initial = yield* drivers.snapshot.exportSnapshot();
        const initialHead = initial.sessions[0]![1].control.journalHeadId;
        expect(initialHead).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const missingHead = structuredClone(initial);
        missingHead.sessions[0]![1].control = {
          ...missingHead.sessions[0]![1].control,
          journalHeadId: null,
        };
        expect(() => authorityStateFromSnapshot(missingHead)).toThrow(
          "invalid journal head identity",
        );
        // Another session must not advance this session's head.
        yield* drivers.authority.command({
          type: "execution.open-task",
          request: { ...open, sessionId: "two" },
        });
        expect(
          (yield* drivers.authority.query({ type: "forest.replay-plan", sessionId: "one" }))
            .journalHeadId,
        ).toBe(initialHead);
        const claim = yield* drivers.authority.command({
          type: "control.claim-activation",
          request: { sessionId: "one", ownerId: "owner" },
        });
        expect(claim).toMatchObject({ status: "claimed", journalHeadId: initialHead });
        const ticket = yield* drivers.authority.command({
          type: "recovery.issue-ticket",
          request: {
            sessionId: "one",
            taskId: "root",
            ownerId: "owner",
            activationEpoch: 1,
            replayedThroughActionIndex: -1,
            replayChainDigest: "b".repeat(64),
          },
        });
        yield* drivers.authority.command({
          type: "control.renew-activation",
          request: { sessionId: "one", ownerId: "owner", epoch: 1 },
        });
        const saved = yield* drivers.snapshot.exportSnapshot();
        expect(saved.sessions.find(([id]) => id === "one")![1].control.journalHeadId).toBe(
          initialHead,
        );
        drivers =
          backend === "stored"
            ? createStoredShellDrivers(store, options)
            : createInMemoryShellDrivers({ ...options, snapshot: saved });
        const bind = {
          sessionId: "one",
          taskId: "root",
          ownerId: "owner",
          activationEpoch: 1,
          restoreTicket: ticket.restoreTicket,
          frontierDigest: "c".repeat(64),
        };
        expect(
          yield* drivers.authority.command({ type: "recovery.bind-frontier", request: bind }),
        ).toMatchObject({ status: "bound" });
        yield* drivers.authority.command({
          type: "execution.append-emission",
          request: {
            sessionId: "one",
            taskId: "root",
            actionIndex: 0,
            programCapability: opened.programCapability,
            descriptor: { eventType: "changed", payload: null },
          },
        });
        const advanced = yield* drivers.snapshot.exportSnapshot();
        expect(advanced.sessions.find(([id]) => id === "one")![1].control.journalHeadId).not.toBe(
          initialHead,
        );
        expect(advanced.sessions.find(([id]) => id === "two")![1].control.journalHeadId).toBe(
          saved.sessions.find(([id]) => id === "two")![1].control.journalHeadId,
        );
        expect(
          yield* drivers.authority.command({ type: "recovery.bind-frontier", request: bind }),
        ).toMatchObject({ status: "restore_stale" });
      });
    });
  });
}

it("publishes the winning head with concurrent journal appends after a control conflict", async () => {
  const store = createMemoryExecutionStore();
  const peer = createStoredShellDrivers(store, options);
  let conflict = true;
  let peerHead: string | null | undefined;
  await run(function* () {
    const open = {
      sessionId: "session",
      turnId: "turn",
      taskId: "root",
      manifest,
      input: null,
      executionEpoch: 1,
      attachmentId: "attachment",
      audience: "host",
    };
    const initial = yield* peer.authority.command({ type: "execution.open-task", request: open });
    const measured = {
      ...store,
      *commitExecution(request: Parameters<typeof store.commitExecution>[0]) {
        if (conflict) {
          conflict = false;
          yield* peer.authority.command({
            type: "execution.append-emission",
            request: {
              sessionId: "session",
              taskId: "root",
              actionIndex: 0,
              programCapability: initial.programCapability,
              descriptor: { eventType: "peer", payload: null },
            },
          });
          peerHead = (yield* peer.snapshot.exportSnapshot()).sessions[0]![1].control.journalHeadId;
        }
        return yield* store.commitExecution(request);
      },
    };
    const contender = createStoredShellDrivers(measured, options);
    yield* contender.authority.command({
      type: "execution.open-task",
      request: { ...open, taskId: "second" },
    });
    const restarted = createStoredShellDrivers(store, options);
    const final = yield* restarted.snapshot.exportSnapshot();
    expect(final.sessions[0]![1].control.journalHeadId).not.toBe(peerHead);
    expect(final.sessions[0]![1].control.revision).toBe(3);
    expect(
      (yield* restarted.journal.readSession("session")).map((record) => record.payload.type),
    ).toEqual(["TaskOpened", "DurableEmission", "TaskOpened"]);
    expect(yield* contender.snapshot.exportSnapshot()).toEqual(final);
  });
});
