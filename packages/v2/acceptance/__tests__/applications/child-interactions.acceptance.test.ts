import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import { createSqliteJournalRig, createJournalStorageRig, readJournal } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createJournalBinding } from "@sweatpan.ts/durable";
import { forEachRuntime } from "../runtime/assembly.ts";

for (const storage of ["memory", "sqlite"] as const) {
  forEachRuntime(<Y>(runtime: Runtime<Y>) => {
    it(`${runtime.name}/${storage}: descendant ingress is bounded by persisted ancestry`, async () => {
      const options = { program: "ancestor", equals: isDeepStrictEqual };
      const store =
        storage === "sqlite"
          ? createSqliteJournalRig<string, string, string, string, unknown, Y>(options)
          : (() => {
              const memory = createMemoryJournalStore<string, string, string, string>(options);
              return { ...memory, reopen: () => memory.open(), close() {} };
            })();
      onTestFinished(() => store.close());
      function start<T>(work: Work<T, Y>) {
        const task = runtime.start(work);
        void task.result.catch(() => undefined);
        onTestFinished(() => task.cancel());
        return task.result;
      }
      let root = store.open();
      let projections = 0;
      const group = await start(() => root.park(0, "branches"));
      if (!group) {
        throw new Error("Expected group request");
      }
      const children = await start(() =>
        root.ensureChildren<string, string, string, string>(group.id, {
          children: [
            { program: "left", input: null },
            { program: "right", input: null },
          ],
          outcome: (values) => {
            projections++;
            return { ok: true, value: values.join(",") };
          },
        }),
      );
      const left = children[0]!.journal;
      const right = children[1]!.journal;
      const call = await start(() => left.park(0, "nested call"));
      if (!call) {
        throw new Error("Expected nested call");
      }
      const leaf = await start(() =>
        left.ensureChild<string, string, string, string>(call.id, {
          program: "grandchild",
          input: null,
          outcome: (value) => {
            projections++;
            return { ok: true, value };
          },
        }),
      );
      const question = await start(() => leaf.journal.park(0, "Approve nested work?"));
      if (!question) {
        throw new Error("Expected question");
      }
      const wait = await start(() => leaf.journal.interactions.register(question.id));
      if (wait.state !== "waiting") {
        throw new Error("Expected waiting grant");
      }
      expect((await start(() => left.openDescendantInteractions(leaf.journal.id))).link).toEqual(
        leaf.link,
      );
      await expect(start(() => left.openDescendantInteractions(right.id))).rejects.toThrow(
        "outside",
      );
      await expect(start(() => right.openDescendantInteractions(leaf.journal.id))).rejects.toThrow(
        "outside",
      );
      await expect(start(() => left.openDescendantInteractions(root.id))).rejects.toThrow(
        "outside",
      );
      await expect(start(() => root.openDescendantInteractions(root.id))).rejects.toThrow(
        "own descendant",
      );
      await expect(start(() => root.openDescendantInteractions("missing"))).rejects.toThrow(
        "outside",
      );
      root = store.reopen();
      const before = await start(() => readJournal(root));
      const intent = await start(() => store.activations.read());
      const ingress = await start(() => root.openDescendantInteractions(leaf.journal.id));
      expect(ingress.link.program).toBe("grandchild");
      expect(ingress.link.parentId).toBe(left.id);
      expect(Object.keys(ingress.journal).sort()).toEqual(["id", "interactions"]);
      expect(await start(() => ingress.journal.interactions.request(wait.grant))).toBe(
        "Approve nested work?",
      );
      expect(await start(() => readJournal(root))).toEqual(before);
      expect(await start(() => store.activations.read())).toEqual(intent);
      const accepted = await start(() =>
        ingress.journal.interactions.answer(wait.grant, { ok: true, value: "yes" }),
      );
      expect(accepted.duplicate).toBe(false);
      expect(await start(() => readJournal(root))).toEqual(before);
      expect(await start(() => store.activations.read())).not.toEqual(intent);
      expect(projections).toBe(0);
      root = store.reopen();
      const retry = await start(() => root.openDescendantInteractions(leaf.journal.id));
      expect(
        await start(() =>
          retry.journal.interactions.answer(wait.grant, { ok: true, value: "yes" }),
        ),
      ).toEqual({ ...accepted, duplicate: true });
      expect(projections).toBe(0);
    });
    it(`${runtime.name}/${storage}: reopened child answers need no execution projection`, async () => {
      const options = { program: "answer-parent", equals: isDeepStrictEqual };
      const store =
        storage === "sqlite"
          ? createSqliteJournalRig<string, string, string, string, unknown, Y>(options)
          : (() => {
              const memory = createMemoryJournalStore<string, string, string, string>(options);
              return { ...memory, reopen: () => memory.open(), close() {} };
            })();
      onTestFinished(() => store.close());
      function start<T>(work: Work<T, Y>) {
        const task = runtime.start(work);
        void task.result.catch(() => undefined);
        onTestFinished(() => task.cancel());
        return task.result;
      }
      let parent = store.open();
      let projections = 0;
      const definition = {
        program: "answer-child",
        input: null,
        outcome: (value: string) => {
          projections++;
          return { ok: true as const, value: `child:${value}` };
        },
      };
      // Public journal protocol: parent owns a child parked at a participant boundary.
      const pending = await start(() => parent.park(0, "call child"));
      if (!pending) {
        throw new Error("Expected parent request");
      }
      const child = await start(() =>
        parent.ensureChild<string, string, string, string>(pending.id, definition),
      );
      const question = await start(() => child.journal.park(0, "Approve?"));
      if (!question) {
        throw new Error("Expected question");
      }
      const registration = await start(() => child.journal.interactions.register(question.id));
      if (registration.state !== "waiting") {
        throw new Error("Expected interaction");
      }
      parent = store.reopen(); // fresh projection registry, not just a new facade
      const before = await start(() => readJournal(parent));
      const intent = await start(() => store.activations.read());
      const ingress = await start(() =>
        parent.openChildInteractions<string, string, string>(
          child.link.childId,
          definition.program,
        ),
      );
      expect(Object.keys(ingress.journal).sort()).toEqual(["id", "interactions"]);
      expect(Object.keys(ingress.journal.interactions).sort()).toEqual(["answer", "request"]);
      expect(ingress.link).toEqual(child.link);
      expect(await start(() => ingress.journal.interactions.request(registration.grant))).toBe(
        "Approve?",
      );
      await expect(
        start(() => parent.openChildInteractions(child.link.childId, "wrong-program")),
      ).rejects.toThrow("program mismatch");
      await expect(
        start(() => parent.openChildInteractions(parent.id, options.program)),
      ).rejects.toThrow("direct owned child");
      await expect(
        start(() => parent.openChildInteractions("missing", definition.program)),
      ).rejects.toThrow("direct owned child");
      await expect(
        start(() =>
          ingress.journal.interactions.answer(
            { ...registration.grant, resolutionId: "forged" },
            { ok: true, value: "yes" },
          ),
        ),
      ).rejects.toThrow("Unknown resolution authority");
      expect(await start(() => readJournal(parent))).toEqual(before);
      expect(await start(() => store.activations.read())).toEqual(intent);
      const accepted = await start(() =>
        ingress.journal.interactions.answer(registration.grant, { ok: true, value: "yes" }),
      );
      expect(accepted.duplicate).toBe(false);
      expect(projections).toBe(0);
      expect(await start(() => readJournal(parent))).toEqual(before);
      expect(await start(() => store.activations.read())).not.toEqual(intent);
      const reader = await start(() => parent.openChild(child.link.childId));
      const answered = await start(() => reader.read());
      expect(answered.status).toBe("running");
      expect(answered.frontier.position).toBe(1);
      // Execution later reattaches its projection; answering did not complete either node.
      const executable = await start(() =>
        parent.ensureChild<string, string, string, string>(pending.id, definition),
      );
      await start(() => executable.journal.complete(answered.revision, "done"));
      expect(projections).toBe(1);
      const settled = await start(() => parent.read());
      await start(() => parent.complete(settled.revision, "finished"));
      parent = store.reopen();
      const terminalBefore = await start(() => readJournal(parent));
      const terminalIntent = await start(() => store.activations.read());
      const historical = await start(() =>
        parent.openChildInteractions<string, string, string>(
          child.link.childId,
          definition.program,
        ),
      );
      expect(await start(() => historical.journal.interactions.request(registration.grant))).toBe(
        "Approve?",
      );
      const duplicate = await start(() =>
        historical.journal.interactions.answer(registration.grant, { ok: true, value: "yes" }),
      );
      expect(duplicate).toEqual({ ...accepted, duplicate: true });
      await expect(
        start(() =>
          historical.journal.interactions.answer(registration.grant, { ok: true, value: "no" }),
        ),
      ).rejects.toThrow();
      expect(await start(() => readJournal(parent))).toEqual(terminalBefore);
      expect(await start(() => store.activations.read())).toEqual(terminalIntent);
      expect(projections).toBe(1);
    });
  });
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it.each(["missing-forward-link", "cycle"] as const)(
    `${runtime.name}: descendant ingress rejects corrupt persisted ancestry (%s)`,
    async (damage) => {
      const storage = createJournalStorageRig(runtime, "ancestor");
      const root = createJournalBinding<string, string, string, string, unknown, Y>(
        { program: "ancestor", equals: isDeepStrictEqual },
        storage.backend,
        storage.id,
      );
      const task = runtime.start(function* () {
        const pending = yield* root.park(0, "branch");
        if (!pending) {
          throw new Error("Expected pending call");
        }
        const branch = yield* root.ensureChild<string, string, string, string>(pending.id, {
          program: "branch",
          input: null,
          outcome: (value) => ({ ok: true, value }),
        });
        const nested = yield* branch.journal.park(0, "leaf");
        if (!nested) {
          throw new Error("Expected nested call");
        }
        const leaf = yield* branch.journal.ensureChild<string, string, string, string>(nested.id, {
          program: "leaf",
          input: null,
          outcome: (value) => ({ ok: true, value }),
        });
        // Scripted storage peer injects damaged persisted evidence, not a mocked resolver.
        yield* storage.backend.transact(function* (transaction) {
          const records = transaction.records;
          if (damage === "missing-forward-link") {
            const request = yield* records.request(root.id, pending.id);
            yield* records.setRequest(root.id, pending.id, { ...request, children: [] });
          } else {
            const record = (yield* records.get(branch.journal.id))!;
            const link = { ...branch.link, parentId: leaf.journal.id, requestId: "cycle" };
            yield* records.set(branch.journal.id, { ...record, parent: link });
            yield* records.setRequest(leaf.journal.id, "cycle", { children: [link] });
          }
        });
        const eventStart = storage.events.length;
        yield* runtime.composition.catchError(
          function* () {
            yield* root.openDescendantInteractions(leaf.journal.id);
            throw new Error("Expected damaged ancestry to reject");
          },
          function* (error) {
            expect(String(error)).toContain(
              damage === "cycle" ? "Cyclic owned ancestry" : "Inconsistent owned child link",
            );
          },
        );
        expect(
          storage.events
            .slice(eventStart)
            .filter((event) => ["set", "setRequest", "append"].includes(event)),
        ).toEqual([]);
      });
      onTestFinished(() => task.cancel());
      await task.result;
    },
  );
});
