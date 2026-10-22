import { expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { executionApplication, executionClient } from "./fixtures/execution-scenario.ts";

for (const binding of ["in-process", "http"] as const) {
  for (const language of ["scheme", "lua"]) {
    it(`${binding}/${language}: host replacement preserves approval, cleanup and one host receipt`, async () => {
      const createApplication = await executionApplication();
      await withTestScenario(
        { binding, createApplication, scenarioTimeoutMs: 30000 },
        function* (s) {
          const execution = executionClient(s);
          let view = yield* execution.command({ action: "start", language });
          expect(view.pending?.key).toBe("approval");
          expect(view.outbox).toEqual([]);
          const approval = view.pending;
          yield* s.host.replace();
          view = yield* execution.read(view.id);
          expect(view.pending).toEqual(approval);
          view = yield* execution.command({
            action: "restore",
            id: view.id,
            revision: view.revision,
          });
          expect(view.restoration?.stateUnchanged).toBe(true);
          view = yield* execution.command({
            action: "reply",
            id: view.id,
            revision: view.revision,
            choice: "approve",
          });
          expect(view.pending?.key).toBe("cleanup");
          expect(view.outbox).toEqual([]);
          const cleanup = view.pending;
          yield* s.host.replace();
          view = yield* execution.read(view.id);
          expect(view.pending).toEqual(cleanup);
          view = yield* execution.command({
            action: "restore",
            id: view.id,
            revision: view.revision,
          });
          expect(view.restoration?.stateUnchanged).toBe(true);
          expect(view.outbox).toEqual([]);
          view = yield* execution.command({
            action: "reply",
            id: view.id,
            revision: view.revision,
            choice: "release",
          });
          expect(view.status).toBe("completed");
          expect(view.pending).toBeNull();
          expect(view.outbox).toHaveLength(1);
          expect(view.result).toEqual({ state: "completed", value: view.outbox[0] });
          expect(view.trace.filter((event) => event.kind === "kernel.start")).toHaveLength(1);
          const completed = view;
          yield* s.host.replace();
          expect(yield* execution.read(view.id)).toEqual(completed);
        },
      );
    }, 60000);

    it(`${binding}/${language}: cancellation survives replacement during cleanup without sending`, async () => {
      const createApplication = await executionApplication();
      await withTestScenario(
        { binding, createApplication, scenarioTimeoutMs: 30000 },
        function* (s) {
          const execution = executionClient(s);
          let view = yield* execution.command({ action: "start", language });
          expect(view.pending?.key).toBe("approval");
          view = yield* execution.command({
            action: "cancel",
            id: view.id,
            revision: view.revision,
          });
          expect(view.pending?.key).toBe("cleanup");
          expect(view.outbox).toEqual([]);
          const cleanup = view.pending;
          yield* s.host.replace();
          view = yield* execution.read(view.id);
          expect(view.pending).toEqual(cleanup);
          view = yield* execution.command({
            action: "cancel",
            id: view.id,
            revision: view.revision,
          });
          expect(view.pending).toEqual(cleanup);
          view = yield* execution.command({
            action: "reply",
            id: view.id,
            revision: view.revision,
            choice: "release",
          });
          expect(view.result).toEqual({ state: "cancelled" });
          expect(view.pending).toBeNull();
          expect(view.outbox).toEqual([]);
          yield* s.host.replace();
          expect((yield* execution.read(view.id)).result).toEqual({ state: "cancelled" });
        },
      );
    }, 60000);
  }
}

for (const language of ["scheme", "lua"]) {
  it(`${language}: composition middleware observes fresh and restored executions without changing receipts`, async () => {
    const events: string[] = [];
    const createApplication = await executionApplication({
      middleware: [
        {
          *createKernel(args, next) {
            events.push("create");
            return yield* next(...args);
          },
        },
      ],
      kernelMiddleware: [
        {
          *start(args, next) {
            events.push("start");
            return yield* next(...args);
          },
          *restore(args, next) {
            events.push("restore");
            return yield* next(...args);
          },
        },
      ],
      executionMiddleware: [
        {
          *resume(args, next) {
            const boundary = yield* next(...args);
            events.push(`resume:${boundary.kind}`);
            return boundary;
          },
          *capture(args, next) {
            events.push("capture");
            return yield* next(...args);
          },
          *dispose(args, next) {
            events.push("dispose");
            return yield* next(...args);
          },
        },
      ],
    });
    await withTestScenario(
      { binding: "http", createApplication, scenarioTimeoutMs: 30000 },
      function* (s) {
        const execution = executionClient(s);
        let view = yield* execution.command({ action: "start", language });
        expect(view.pending?.key).toBe("approval");
        expect(events).toContain("start");
        expect(events).toContain("capture");
        expect(events).toContain("dispose");
        events.length = 0;
        yield* s.host.replace();
        view = yield* execution.command({
          action: "reply",
          id: view.id,
          revision: view.revision,
          choice: "approve",
        });
        expect(view.pending?.key).toBe("cleanup");
        expect(view.outbox).toEqual([]);
        expect(events).toContain("create");
        expect(events).toContain("restore");
        expect(events).not.toContain("start");
        expect(events).toContain("resume:suspended");
        expect(events).toContain("capture");
        events.length = 0;
        yield* s.host.replace();
        view = yield* execution.command({
          action: "reply",
          id: view.id,
          revision: view.revision,
          choice: "release",
        });
        expect(view.status).toBe("completed");
        expect(view.outbox).toHaveLength(1);
        expect(view.result).toEqual({ state: "completed", value: view.outbox[0] });
        expect(events).toContain("restore");
        expect(events).toContain("resume:completed");
        expect(events).toContain("dispose");
      },
    );
  }, 60000);
}
